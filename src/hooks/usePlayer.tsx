import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { AppState, Platform, ToastAndroid } from 'react-native';
import { AppError, messageFor, toAppError } from '../core/errors';
import { RepeatMode, ResolvedStream, Track } from '../core/types';
import { flushWrites, readJson, writeJsonDebounced, STORAGE_KEYS } from '../core/storage';
import { playbackEngine, IDLE_STATUS, PlaybackStatus } from '../playback/PlaybackEngine';
import { Queue, QueueSnapshot, EMPTY_QUEUE } from '../playback/queue';
import { preloader } from '../playback/preload';
import { endpointSource } from '../providers/stream/StreamResolver';
import {
  DownloadService,
  DownloadedTrack,
} from '../services/DownloadService';
import { ConnectivityService } from '../services/ConnectivityService';
import { LibraryService } from '../services/LibraryService';
import { MusicService } from '../services/MusicService';

/** Sleep timer: off, a wall-clock countdown, or "pause when this song ends". */
export type SleepTimerState =
  | { mode: 'off' }
  | { mode: 'minutes'; minutes: number; endsAt: number }
  | { mode: 'endOfTrack' };

type PlayerContextType = {
  // --- the original mock API, unchanged so existing screens keep working ---
  currentTrack: Track | null;
  isPlaying: boolean;
  playTrack: (track: Track, context?: { tracks?: Track[]; label?: string }) => void;
  /**
   * Start a radio station from one song: play it as a fresh queue, then
   * seed the queue with its related tracks right away (and keep topping
   * up, per the autoplay-related setting).
   */
  startRadio: (track: Track) => void;
  /** Play a saved (encrypted) song from its local file -- no network. */
  playOffline: (record: DownloadedTrack) => void;
  togglePlayPause: () => void;

  // --- everything the real player adds ---
  isLoading: boolean;
  isBuffering: boolean;
  error: string | null;
  clearError: () => void;
  retry: () => void;

  duration: number;
  volume: number;
  setVolume: (v: number) => void;
  seekTo: (seconds: number) => void;
  /** Jump relative to the current position. Negative rewinds. */
  seekBy: (deltaSeconds: number) => void;

  next: () => void;
  previous: () => void;
  hasNext: boolean;
  hasPrevious: boolean;

  queue: Track[];
  upcoming: Track[];
  queueContext: string;
  addToQueue: (tracks: Track | Track[]) => void;
  playNext: (tracks: Track | Track[]) => void;
  removeFromQueue: (trackId: string) => void;
  reorderQueue: (from: number, to: number) => void;
  clearQueue: () => void;
  jumpTo: (trackId: string) => void;

  shuffle: boolean;
  toggleShuffle: () => void;
  repeat: RepeatMode;
  cycleRepeat: () => void;

  isReady: boolean;
  canPlayCurrent: boolean;

  sleepTimer: SleepTimerState;
  /** Arm (minutes | 'endOfTrack') or cancel (null) the sleep timer. */
  setSleepTimer: (option: number | 'endOfTrack' | null) => void;
};

/**
 * How long a track must actually play before it counts as a listen.
 *
 * Tapping a track and skipping it immediately is not listening, so history is
 * gated on real playback rather than on intent. Short tracks use a proportion
 * instead, so a 30s clip is not excluded by a fixed threshold.
 */
const HISTORY_MIN_SECONDS = 20;
const HISTORY_MIN_RATIO = 0.25;

/** How many unplayable tracks in a row we step over before giving up. */
const MAX_AUTO_SKIPS = 3;

/**
 * How many recently played tracks the queue continuation treats as
 * "already heard". Bounded on purpose: with an endless related-tracks
 * chain, filtering against the whole session would eventually leave
 * nothing fresh to add.
 */
const RECENT_WINDOW = 50;

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

/**
 * Progress lives in its own context because it updates ~4x a second. Screens
 * that only need the current track never re-render on a position tick.
 */
const ProgressContext = createContext<{ position: number; duration: number }>({
  position: 0,
  duration: 0,
});

export const PlayerProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const queueRef = useRef(new Queue());

  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [status, setStatus] = useState<PlaybackStatus>(IDLE_STATUS);
  /**
   * Mirror of  for callbacks that only READ it.
   *
   * Position ticks ~4x a second. A callback that lists status.position in its
   * deps is rebuilt just as often, and because these callbacks sit in the
   * context value, that rebuilt the whole value 4x a second -- re-rendering
   * every screen using usePlayer and undoing the progress isolation.
   */
  const statusRef = useRef<PlaybackStatus>(IDLE_STATUS);
  statusRef.current = status;
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [queueVersion, setQueueVersion] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [sleepTimer, setSleepTimerState] = useState<SleepTimerState>({ mode: 'off' });

  /** Cancels an in-flight load when the user starts another one. */
  const loadAbort = useRef<AbortController | null>(null);
  /** Identifies the newest load so stale async work can bail out. */
  const loadId = useRef(0);
  /** The track we most recently attempted, for retry(). */
  const lastAttempt = useRef<{ track: Track; position: number } | null>(null);
  /** Which track the in-flight load belongs to, so we never abort our own. */
  const loadingTrackId = useRef<string | null>(null);
  /**
   * A one-shot stream override for the next load of a specific track, set by
   * playOffline: the saved song's loopback URL, so loadCurrent plays the
   * local encrypted file instead of resolving a network stream. Consumed by
   * the first load that matches; a load for any other track leaves it be.
   */
  const forcedStream = useRef<{ trackId: string; stream: ResolvedStream } | null>(null);
  /**
   * Consecutive tracks auto-skipped because they would not play. Bounded so a
   * queue full of dead videos stops instead of racing to the end.
   */
  const autoSkips = useRef(0);
  /** Serializes queue extensions so top-ups and end-of-queue advances never race. */
  const extensionChainRef = useRef<Promise<void> | null>(null);
  /** Ids of tracks loaded this session (newest last), feeding the fresh window. */
  const playedIdsRef = useRef<string[]>([]);
  /** Wall-clock sleep timer handle, when a minutes timer is armed. */
  const sleepTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** "End of current song" sleep: pause at the next natural track end. */
  const sleepAtTrackEndRef = useRef(false);
  /** Load id whose listen has already been written to history. */
  const historyWrittenFor = useRef<number | null>(null);

  const bumpQueue = useCallback(() => setQueueVersion((v) => v + 1), []);

  // ---- persistence ------------------------------------------------------

  const persistQueue = useCallback(() => {
    writeJsonDebounced(STORAGE_KEYS.queue, queueRef.current.snapshot(), 600);
  }, []);

  // ---- loading a track --------------------------------------------------

  /** Remember a loaded track for the continuation's recent window. */
  const notePlayed = (trackId: string) => {
    const ids = playedIdsRef.current;
    ids.push(trackId);
    if (ids.length > RECENT_WINDOW) ids.splice(0, ids.length - RECENT_WINDOW);
  };

  const loadCurrent = useCallback(
    async (options: { autoPlay?: boolean; startPosition?: number } = {}) => {
      const track = queueRef.current.current;
      if (!track) {
        setCurrentTrack(null);
        setIsLoading(false);
        playbackEngine.stop();
        return;
      }

      const id = ++loadId.current;

      // Only abort the previous load if it was for a DIFFERENT track. Aborting
      // a load of this same track would kill the shared in-flight resolve that
      // this load is about to join (double-tap on a row does exactly that).
      if (loadingTrackId.current !== track.id) {
        loadAbort.current?.abort();
      }

      const controller = new AbortController();
      loadAbort.current = controller;
      loadingTrackId.current = track.id;

      const preloadedThis = preloader.pending === track.id;
      historyWrittenFor.current = null;

      // Stop warming anything that is no longer next -- but if we were warming
      // THIS track, adopt that request instead of aborting it: resolveStream
      // below will be handed the very same in-flight promise.
      preloader.adopt(track.id);

      if (__DEV__) {
        console.log('[playback] load', track.title, '| preloaded:', preloadedThis);
      }

      setCurrentTrack(track);
      setError(null);
      setIsLoading(true);
      lastAttempt.current = { track, position: options.startPosition ?? 0 };

      try {
        // An explicit offline play (Offline section) hands us its stream.
        // Every other play is storage-first (Phase 3): if this track is
        // saved, it plays from its encrypted local file — no network, no
        // re-download — whatever screen started it (Search, Home recents,
        // History, Liked, playlists, the queue). Only unsaved tracks, and
        // stale records (which getSavedStream drops), fall through to a
        // network resolve. loadCurrent is the one choke point every play
        // action funnels through, so this single check covers them all.
        let stream: ResolvedStream;
        if (forcedStream.current?.trackId === track.id) {
          stream = forcedStream.current.stream;
          forcedStream.current = null;
        } else {
          const saved = await DownloadService.getSavedStream(track);
          if (id !== loadId.current) return; // superseded by a newer load
          stream = saved ?? (await MusicService.resolveStream(track, controller.signal));
        }
        if (id !== loadId.current) return; // superseded by a newer load

        await playbackEngine.load(track, stream, options);
        if (id !== loadId.current) return;

        setIsLoading(false);
        autoSkips.current = 0;
        loadingTrackId.current = null;
        if (__DEV__) console.log('[playback] started', track.title);
        LibraryService.recordPlay(track);
        notePlayed(track.id);

        // Warm exactly one track ahead, so pressing skip is instant.
        preloader.schedule(queueRef.current.peekNext());

        // Continuous playback: top the queue up BEFORE it runs dry, so a
        // track ending never has to wait on the network. The extension
        // applies the settings / offline / connectivity gates itself.
        if (queueRef.current.repeat === 'off' && queueRef.current.upcoming.length <= 2) {
          void extendWithRelated('append');
        }
      } catch (e) {
        if (id !== loadId.current) return;

        // Always leave the loading state, whatever went wrong.
        setIsLoading(false);
        loadingTrackId.current = null;
        const err = toAppError(e, 'playback_failed');
        if (__DEV__) console.log('[playback] FAILED', track.title, '|', err.kind, '|', err.detail ?? '');

        // A dead stream URL should not be reused on retry.
        if (err.kind !== 'network' && err.kind !== 'timeout') {
          MusicService.invalidateStream(track);
        }

        // A track that cannot play must not strand the session: step over
        // it and keep going -- a dead video, a failed resolve, even a
        // network blip (the next track may well be a saved local file).
        // Bounded by MAX_AUTO_SKIPS, so a run of failures still stops
        // cleanly instead of racing through the whole queue.
        const skippable =
          err.kind === 'track_unavailable' ||
          err.kind === 'region_restricted' ||
          err.kind === 'source_unavailable' ||
          err.kind === 'playback_failed' ||
          err.kind === 'network' ||
          err.kind === 'timeout' ||
          err.kind === 'rate_limited' ||
          err.kind === 'unknown';

        if (skippable && autoSkips.current < MAX_AUTO_SKIPS) {
          autoSkips.current += 1;
          if (__DEV__) console.log('[playback] auto-skip', autoSkips.current, 'past', track.title);

          const nextTrack = queueRef.current.next(false);
          if (nextTrack) {
            bumpQueue();
            persistQueue();
            void loadCurrent({ autoPlay: true });
            return;
          }

          // Nothing queued behind the dead track: give the continuation a
          // chance to fetch more before the session ends. If it finds
          // tracks, its load clears this error; if not, playback stops
          // here with the error left visible.
          setError(messageFor(err));
          void extendWithRelated('advance');
          return;
        }

        autoSkips.current = 0;
        setError(messageFor(err));
      }
    },
    [bumpQueue, persistQueue]
  );

  // ---- engine wiring ----------------------------------------------------

  useEffect(() => {
    playbackEngine.on('onStatus', (s) => setStatus(s));

    playbackEngine.on('onComplete', () => {
      // Sleep timer, "end of current song": pause here instead of
      // advancing. It also wins over repeat-one -- the song HAS ended.
      if (sleepAtTrackEndRef.current) {
        sleepAtTrackEndRef.current = false;
        setSleepTimerState({ mode: 'off' });
        playbackEngine.pause();
        return;
      }

      // `auto` so repeat-one replays rather than advances.
      const nextTrack = queueRef.current.next(true);
      bumpQueue();
      persistQueue();

      if (!nextTrack) {
        // End of queue: keep going with related tracks.
        void extendWithRelated('advance');
        return;
      }
      void loadCurrent({ autoPlay: true });
    });

    playbackEngine.on('onError', (e) => {
      setIsLoading(false);
      setError(messageFor(e instanceof AppError ? e : toAppError(e, 'playback_failed')));
    });

    return () => {
      preloader.cancel();
      if (sleepTimeoutRef.current) clearTimeout(sleepTimeoutRef.current);
      void playbackEngine.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * One queue extension: fetch related tracks and append them, optionally
   * advancing into them. Runs in two modes:
   *
   *   'append'  -- a top-up while playback continues (loadCurrent calls it
   *                when the upcoming buffer runs low), so the queue never
   *                runs dry mid-session;
   *   'advance' -- the queue HAS run out (track ended, manual skip, or a
   *                dead track with nothing behind it): after appending,
   *                move into the next track and play it.
   *
   * Because an appended batch is itself finite, an 'advance' eventually
   * happens again for the batch's last track, whose own related tracks
   * extend the chain further -- playback rolls on until the user stops
   * it, the setting is off, the device goes offline, or every source
   * below genuinely fails.
   */
  const runExtension = useCallback(
    async (mode: 'advance' | 'append') => {
      const settings = LibraryService.getSettings();
      const last = queueRef.current.current;

      if (!settings.autoplayRelated || !last) return;

      // An explicit Offline play is one pinned song by design -- it must
      // not drift back into streaming (see playOffline). And with no
      // connection there is nothing to fetch: the queue simply ends,
      // which is also the right behaviour for offline saved queues.
      if (queueRef.current.context === 'Offline') return;
      if (!ConnectivityService.check()) return;

      // Advance mode may find the job already done -- a top-up that raced
      // ahead appended tracks while this call waited its turn.
      if (mode === 'advance') {
        const waiting = queueRef.current.next(false);
        if (waiting) {
          bumpQueue();
          persistQueue();
          void loadCurrent({ autoPlay: true });
          return;
        }
      }

      try {
        const recentWindow = new Set(playedIdsRef.current);
        const upcomingIds = new Set(queueRef.current.upcoming.map((t) => t.id));
        const queuedIds = new Set(queueRef.current.items.map((t) => t.id));

        // Every source is judged the same way: anything other than the
        // track that just ended is a candidate (kept as the last-resort
        // pool); candidates outside the recent window are "fresh".
        // Returns true when the source produced fresh tracks.
        const candidateIds = new Set<string>();
        let candidates: Track[] = [];
        let fresh: Track[] = [];
        const consider = (tracks: Track[]): boolean => {
          const usable = tracks.filter((t) => t.id !== last.id);
          for (const t of usable) {
            if (!candidateIds.has(t.id)) {
              candidateIds.add(t.id);
              candidates.push(t);
            }
          }
          fresh = usable.filter((t) => !recentWindow.has(t.id));
          return fresh.length > 0;
        };

        // 1. Related tracks for the song that just ended. One retry: the
        //    radio lookup behind it is two requests and either can blip.
        let extended = consider(await MusicService.getRelated(last));
        if (!extended) extended = consider(await MusicService.getRelated(last));

        // 2. Related tracks for whatever played just before it.
        if (!extended) {
          const previous = LibraryService.getRecentlyPlayed().find(
            (t) => t.id !== last.id
          );
          if (previous) extended = consider(await MusicService.getRelated(previous));
        }

        // 3. More songs by the same artist.
        if (!extended && last.artist.name && last.artist.name !== 'Unknown artist') {
          try {
            const results = await MusicService.search(last.artist.name, {
              filter: 'Songs',
              limit: 25,
            });
            extended = consider(results.tracks);
          } catch {
            // Search is the last network resort; failing changes nothing.
          }
        }

        // The fetches take seconds. If the user started something else in
        // the meantime, their choice wins -- never touch their new queue.
        if (queueRef.current.current?.id !== last.id) return;

        if (!fresh.length && candidates.length) {
          // Nothing fresh, but a repeat beats silence: candidates played
          // earlier in this queue are lifted out and re-appended below;
          // candidates not in the queue at all can simply be added. The
          // just-ended track is excluded by `consider`, so it can never
          // immediately replay itself.
          fresh = candidates.filter((t) => !upcomingIds.has(t.id));
        }
        if (!fresh.length) return;

        // A fresh/repeat track still sitting in the queue's played region
        // must be lifted out before Queue.add will take it again (it
        // de-duplicates by id). Upcoming tracks are left where they are;
        // add() skips them and they play in their turn.
        for (const t of fresh) {
          if (queuedIds.has(t.id) && !upcomingIds.has(t.id)) {
            queueRef.current.remove(t.id);
          }
        }

        queueRef.current.add(fresh.slice(0, 20));
        bumpQueue();
        persistQueue();

        if (mode === 'advance') {
          const nextTrack = queueRef.current.next(false);
          if (nextTrack) void loadCurrent({ autoPlay: true });
        }
      } catch {
        // Autoplay is a convenience; silence is the right failure mode,
        // and nothing in here may ever take the player down with it.
      }
    },
    [bumpQueue, loadCurrent, persistQueue]
  );

  /**
   * Serialize extensions through one promise chain: a top-up in flight
   * when the queue runs out must finish before the advance runs, and the
   * advance then re-reads fresh queue state instead of racing it.
   */
  const extendWithRelated = useCallback(
    (mode: 'advance' | 'append') => {
      const run = (extensionChainRef.current ?? Promise.resolve())
        .then(() => runExtension(mode))
        .catch(() => {});
      extensionChainRef.current = run;
      void run.then(() => {
        if (extensionChainRef.current === run) extensionChainRef.current = null;
      });
      return run;
    },
    [runExtension]
  );

  // ---- sleep timer ------------------------------------------------------

  /** Drop an armed "end of current song" (a fresh explicit queue replaces it). */
  const disarmSleepAtTrackEnd = () => {
    if (!sleepAtTrackEndRef.current) return;
    sleepAtTrackEndRef.current = false;
    setSleepTimerState((s) => (s.mode === 'endOfTrack' ? { mode: 'off' } : s));
  };

  const setSleepTimer = useCallback((option: number | 'endOfTrack' | null) => {
    if (sleepTimeoutRef.current) {
      clearTimeout(sleepTimeoutRef.current);
      sleepTimeoutRef.current = null;
    }
    sleepAtTrackEndRef.current = false;

    if (option === null) {
      setSleepTimerState({ mode: 'off' });
      return;
    }
    if (option === 'endOfTrack') {
      sleepAtTrackEndRef.current = true;
      setSleepTimerState({ mode: 'endOfTrack' });
      return;
    }

    // Wall-clock on purpose: track changes and queue top-ups must not
    // reset it, and it keeps running with the screen closed.
    const endsAt = Date.now() + option * 60_000;
    sleepTimeoutRef.current = setTimeout(() => {
      sleepTimeoutRef.current = null;
      setSleepTimerState({ mode: 'off' });
      playbackEngine.pause();
    }, option * 60_000);
    setSleepTimerState({ mode: 'minutes', minutes: option, endsAt });
  }, []);

  // ---- startup: restore library, settings, queue and position -----------

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await Promise.all([MusicService.init(), LibraryService.load(), DownloadService.load()]);
        if (cancelled) return;

        const settings = LibraryService.getSettings();
        endpointSource.setEndpoints(settings.resolverEndpoints);

        playbackEngine.setVolume(settings.volume);
        setVolumeState(settings.volume);
        void playbackEngine.configure();

        const snapshot = await readJson<QueueSnapshot>(STORAGE_KEYS.queue, EMPTY_QUEUE);
        if (cancelled) return;

        if (snapshot.tracks?.length) {
          queueRef.current.restore(snapshot);
          bumpQueue();

          const restored = queueRef.current.current;
          if (restored) {
            // Restore the track and its position, but never auto-play on
            // launch -- starting audio unprompted is hostile.
            const saved = await LibraryService.getSavedPlayback();
            if (cancelled) return;

            setCurrentTrack(restored);
            lastAttempt.current = {
              track: restored,
              position: saved.trackId === restored.id ? saved.position : 0,
            };
          }
        }
      } catch {
        // A corrupt restore must never prevent the app from starting.
      } finally {
        if (!cancelled) setIsReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Phase 1: listening time + auto-download --------------------------

  // Every status tick feeds the listening tracker. It counts only real
  // played time (seeks are discarded there) and starts a background
  // download once a track's accumulated listening reaches half its length.
  // The load id identifies one play, which is what the per-play cap keys on.
  useEffect(() => {
    if (!currentTrack || !status.isLoaded) return;
    DownloadService.observe(currentTrack, status, loadId.current);
  }, [currentTrack, status]);

  // A toast when an auto-download lands. Phase 1 taught us a toast alone
  // is easy to miss (it never shows with the screen off), so Phase 2 also
  // persists every outcome -- see DownloadService's last download event,
  // which the Offline section displays.
  useEffect(
    () =>
      DownloadService.subscribeDownloadComplete((record) => {
        if (Platform.OS === 'android') {
          ToastAndroid.show(`Saved for offline: ${record.title}`, ToastAndroid.LONG);
        }
      }),
    []
  );

  // ---- persist playback position ---------------------------------------

  // Position ticks ~4x a second but is persisted in whole seconds, so only
  // react when the second actually changes.
  const positionSecond = Math.floor(status.position);

  useEffect(() => {
    if (!currentTrack) return;
    LibraryService.savePlayback(currentTrack.id, positionSecond);

    // A listen is logged once, mid-playback, not on tap and not on finish --
    // so skipping away early leaves no trace, and a track abandoned near the
    // end still counts.
    if (historyWrittenFor.current === loadId.current) return;

    const trackDuration = status.duration || currentTrack.duration || 0;

    const threshold = Math.min(
      HISTORY_MIN_SECONDS,
      trackDuration > 0 ? trackDuration * HISTORY_MIN_RATIO : HISTORY_MIN_SECONDS
    );

    if (positionSecond >= threshold && positionSecond > 0) {
      historyWrittenFor.current = loadId.current;
      LibraryService.recordListen(currentTrack);
      if (__DEV__) console.log('[history] logged', currentTrack.title);
    }
  }, [currentTrack, positionSecond, status.duration]);

  // Flush pending writes when the app goes to the background or the tab closes.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') void flushWrites();
    });

    let onHide: (() => void) | undefined;
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      onHide = () => void flushWrites();
      window.addEventListener('pagehide', onHide);
    }

    return () => {
      sub.remove();
      if (onHide && typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onHide);
      }
    };
  }, []);

  // ---- actions ----------------------------------------------------------

  const playTrack = useCallback(
    (track: Track, context?: { tracks?: Track[]; label?: string }) => {
      disarmSleepAtTrackEnd();
      const list = context?.tracks?.length ? context.tracks : [track];
      const startIndex = Math.max(
        0,
        list.findIndex((t) => t.id === track.id)
      );

      queueRef.current.setTracks(list, startIndex, context?.label ?? '');
      bumpQueue();
      persistQueue();

      void loadCurrent({ autoPlay: true });
    },
    [bumpQueue, loadCurrent, persistQueue]
  );

  /**
   * Start Radio: the seed song as a one-track queue labelled "Radio",
   * with the first related batch fetched immediately.
   *
   * The explicit append (rather than waiting for the queue to run low)
   * is what makes this a station rather than a single play: the batch is
   * requested now, through the same serialized extension chain every
   * top-up uses, and Queue.add de-duplicates, so it cannot double up
   * with the low-queue top-up loadCurrent fires for the seed. With
   * autoplay-related off in Settings the extension no-ops inside
   * runExtension and Radio stays just the seed song, as the user chose.
   */
  const startRadio = useCallback(
    (track: Track) => {
      disarmSleepAtTrackEnd();
      queueRef.current.setTracks([track], 0, 'Radio');
      bumpQueue();
      persistQueue();

      void loadCurrent({ autoPlay: true });
      void extendWithRelated('append');
    },
    [bumpQueue, extendWithRelated, loadCurrent, persistQueue]
  );

  /**
   * Play a saved song from its encrypted local file.
   *
   * The queue becomes just this song — an explicit offline play means
   * "this saved song", not a queue that later drifts back to streaming.
   * General storage-first playback for ordinary plays lives in
   * loadCurrent; this entry point additionally pins the exact record the
   * user tapped.
   */
  const playOffline = useCallback(
    (record: DownloadedTrack) => {
      disarmSleepAtTrackEnd();
      void (async () => {
        const stream = await DownloadService.getOfflineStream(record);
        if (!stream) {
          setError('That saved song is no longer on this phone.');
          return;
        }
        const track = DownloadService.toTrack(record);
        forcedStream.current = { trackId: track.id, stream };
        queueRef.current.setTracks([track], 0, 'Offline');
        bumpQueue();
        persistQueue();
        void loadCurrent({ autoPlay: true });
      })();
    },
    [bumpQueue, loadCurrent, persistQueue]
  );

  const togglePlayPause = useCallback(() => {
    const track = queueRef.current.current ?? currentTrack;
    if (!track) return;

    // Restored-but-never-loaded track: the first press starts it.
    if (playbackEngine.trackId !== track.id) {
      if (!queueRef.current.current) {
        queueRef.current.setTracks([track], 0, '');
        bumpQueue();
      }
      void loadCurrent({
        autoPlay: true,
        startPosition: lastAttempt.current?.position ?? 0,
      });
      return;
    }

    if (status.isPlaying) playbackEngine.pause();
    else playbackEngine.play();
  }, [bumpQueue, currentTrack, loadCurrent, status.isPlaying]);

  const next = useCallback(() => {
    const nextTrack = queueRef.current.next(false);
    bumpQueue();
    persistQueue();

    if (!nextTrack) {
      void extendWithRelated('advance');
      return;
    }
    void loadCurrent({ autoPlay: true });
  }, [bumpQueue, extendWithRelated, loadCurrent, persistQueue]);

  const previous = useCallback(() => {
    // Standard behaviour: restart the track if we are more than 3s in.
    if (statusRef.current.position > 3) {
      void playbackEngine.seekTo(0);
      return;
    }

    queueRef.current.previous();
    bumpQueue();
    persistQueue();
    void loadCurrent({ autoPlay: true });
  }, [bumpQueue, loadCurrent, persistQueue]);

  const seekTo = useCallback((seconds: number) => {
    void playbackEngine.seekTo(seconds);
  }, []);

  /**
   * Relative seek, matching the +/-10s the lock screen offers.
   * Clamped to the track so it cannot run past either end.
   */
  const seekBy = useCallback(
    (deltaSeconds: number) => {
      const { duration, position } = statusRef.current;
      const total = duration || currentTrack?.duration || 0;
      const target = position + deltaSeconds;
      const clamped = total > 0 ? Math.min(total, Math.max(0, target)) : Math.max(0, target);
      void playbackEngine.seekTo(clamped);
    },
    [currentTrack?.duration]
  );

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    playbackEngine.setVolume(clamped);
    setVolumeState(clamped);
    LibraryService.updateSettings({ volume: clamped });
  }, []);

  const retry = useCallback(() => {
    const attempt = lastAttempt.current;
    if (!attempt) return;

    setError(null);
    MusicService.invalidateStream(attempt.track);
    void loadCurrent({ autoPlay: true, startPosition: attempt.position });
  }, [loadCurrent]);

  const clearError = useCallback(() => setError(null), []);

  // ---- queue operations -------------------------------------------------

  const addToQueue = useCallback(
    (tracks: Track | Track[]) => {
      const wasEmpty = queueRef.current.length === 0;
      queueRef.current.add(tracks);
      bumpQueue();
      persistQueue();

      if (wasEmpty) void loadCurrent({ autoPlay: true });
    },
    [bumpQueue, loadCurrent, persistQueue]
  );

  const playNextInQueue = useCallback(
    (tracks: Track | Track[]) => {
      const wasEmpty = queueRef.current.length === 0;
      queueRef.current.playNext(tracks);
      bumpQueue();
      persistQueue();

      if (wasEmpty) void loadCurrent({ autoPlay: true });
      else preloader.schedule(queueRef.current.peekNext());
    },
    [bumpQueue, loadCurrent, persistQueue]
  );

  const removeFromQueue = useCallback(
    (trackId: string) => {
      const removedCurrent = queueRef.current.remove(trackId);
      bumpQueue();
      persistQueue();

      // Removing the playing track slides the next one into its place.
      if (removedCurrent) {
        if (queueRef.current.current) void loadCurrent({ autoPlay: true });
        else {
          playbackEngine.stop();
          setCurrentTrack(null);
        }
      }
    },
    [bumpQueue, loadCurrent, persistQueue]
  );

  const reorderQueue = useCallback(
    (from: number, to: number) => {
      queueRef.current.reorder(from, to);
      bumpQueue();
      persistQueue();
    },
    [bumpQueue, persistQueue]
  );

  const clearQueue = useCallback(() => {
    queueRef.current.clearUpcoming();
    bumpQueue();
    persistQueue();
  }, [bumpQueue, persistQueue]);

  const jumpTo = useCallback(
    (trackId: string) => {
      const track = queueRef.current.jumpTo(trackId);
      if (!track) return;

      bumpQueue();
      persistQueue();
      void loadCurrent({ autoPlay: true });
    },
    [bumpQueue, loadCurrent, persistQueue]
  );

  const toggleShuffle = useCallback(() => {
    queueRef.current.toggleShuffle();
    bumpQueue();
    persistQueue();
    preloader.schedule(queueRef.current.peekNext());
  }, [bumpQueue, persistQueue]);

  const cycleRepeat = useCallback(() => {
    queueRef.current.cycleRepeat();
    bumpQueue();
    persistQueue();
  }, [bumpQueue, persistQueue]);

  // ---- context values ---------------------------------------------------

  const queueSnapshot = useMemo(
    () => ({
      items: queueRef.current.items,
      upcoming: queueRef.current.upcoming,
      context: queueRef.current.context,
      shuffle: queueRef.current.shuffle,
      repeat: queueRef.current.repeat,
      hasNext: queueRef.current.hasNext,
      hasPrevious: queueRef.current.hasPrevious,
    }),
    // queueVersion is the explicit invalidation signal for the mutable Queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queueVersion]
  );

  // Prefer the source-reported duration, falling back to provider metadata
  // so the scrubber is usable before the stream reports one.
  const duration = status.duration || currentTrack?.duration || 0;

  const value = useMemo<PlayerContextType>(
    () => ({
      currentTrack,
      isPlaying: status.isPlaying,
      playTrack,
      startRadio,
      playOffline,
      togglePlayPause,

      isLoading,
      isBuffering: status.isBuffering,
      error,
      clearError,
      retry,

      duration,
      volume,
      setVolume,
      seekTo,
      seekBy,

      next,
      previous,
      hasNext: queueSnapshot.hasNext,
      hasPrevious: queueSnapshot.hasPrevious,

      queue: queueSnapshot.items,
      upcoming: queueSnapshot.upcoming,
      queueContext: queueSnapshot.context,
      addToQueue,
      playNext: playNextInQueue,
      removeFromQueue,
      reorderQueue,
      clearQueue,
      jumpTo,

      shuffle: queueSnapshot.shuffle,
      toggleShuffle,
      repeat: queueSnapshot.repeat,
      cycleRepeat,

      isReady,
      canPlayCurrent: currentTrack ? MusicService.canPlay(currentTrack) : false,

      sleepTimer,
      setSleepTimer,
    }),
    [
      currentTrack,
      status.isPlaying,
      status.isBuffering,
      playTrack,
      startRadio,
      playOffline,
      togglePlayPause,
      isLoading,
      error,
      clearError,
      retry,
      duration,
      volume,
      setVolume,
      seekTo,
      seekBy,
      next,
      previous,
      queueSnapshot,
      addToQueue,
      playNextInQueue,
      removeFromQueue,
      reorderQueue,
      clearQueue,
      jumpTo,
      toggleShuffle,
      cycleRepeat,
      isReady,
      sleepTimer,
      setSleepTimer,
    ]
  );

  const progressValue = useMemo(
    () => ({ position: status.position, duration }),
    [status.position, duration]
  );

  return (
    <PlayerContext.Provider value={value}>
      <ProgressContext.Provider value={progressValue}>{children}</ProgressContext.Provider>
    </PlayerContext.Provider>
  );
};

export const usePlayer = () => {
  const context = useContext(PlayerContext);
  if (context === undefined) {
    throw new Error('usePlayer must be used within a PlayerProvider');
  }
  return context;
};

/** Subscribe to playback position without re-rendering on every other change. */
export const useProgress = () => useContext(ProgressContext);
