import { Directory, Paths } from 'expo-file-system';
import {
  deleteOfflineFile,
  downloadAndEncryptStream,
  getOfflinePlaybackUrl,
  offlineFileInfo,
} from '../../modules/note-native';
import {
  readJson,
  writeJson,
  writeJsonDebounced,
  STORAGE_KEYS,
} from '../core/storage';
import { ResolvedStream, Track } from '../core/types';
import { MusicService } from './MusicService';

/**
 * Listening-time tracking + encrypted offline storage (Phases 1-2).
 *
 * Two persistent stores, both keyed by the composite track id
 * (`<provider>:<sourceId>`), so Phase 3 (storage-first playback, 3 GB
 * eviction) can join them by id:
 *
 *   listening  trackId -> total seconds actually listened. This total is the
 *              eviction score Phase 3 will rank downloads by.
 *   downloads  trackId -> the saved (encrypted) file and its metadata.
 *
 * "Actually listened" is measured from playback position deltas while the
 * player reports playing, cross-checked against wall-clock time: a seek
 * moves the position far faster than real time, so the jump is discarded
 * instead of counted. Within one play (one load of a track) at most one
 * full duration is counted, so looping or scrubbing back and replaying a
 * section cannot inflate the score past the track's length per play.
 *
 * Phase 2: when a track crosses the trigger, its audio is downloaded by the
 * native module straight into AES-256-GCM encrypted storage (Android
 * Keystore key) -- no plain audio file ever exists. Playback of a saved
 * song goes through the native loopback server, which decrypts on the fly.
 *
 * Every download attempt, success or failure, is recorded as the persistent
 * `lastEvent`, because Phase 1's only signal (a toast) was easy to miss and
 * its failures were silent. The Offline section shows that event.
 */

export type ListeningRecord = {
  trackId: string;
  /** Total seconds listened across all plays. */
  totalSeconds: number;
  /** Last known duration in seconds (0 when unknown). */
  duration: number;
  /** Display metadata, captured from playback (Phase 2; absent in v1 data). */
  title?: string;
  artist?: string;
  updatedAt: number;
};

export type DownloadedTrack = {
  /** Composite track id (`<provider>:<sourceId>`). */
  trackId: string;
  /** Provider-native id (YouTube videoId); also the file's base name. */
  sourceId: string;
  title: string;
  artist: string;
  albumImageUrl?: string;
  duration: number;
  /** Absolute path of the saved file (ciphertext for Phase 2 saves). */
  filePath: string;
  /** Size on disk in bytes (the encrypted size for Phase 2 saves). */
  fileSize: number;
  mimeType?: string;
  downloadedAt: number;
  /** Listening total at the moment the download completed. */
  listeningSeconds: number;
  /** Phase 2 saves are AES-256-GCM encrypted; absent means a v1 plain save. */
  encrypted?: boolean;
  /** Encrypted file format version (1 = chunked AES-GCM). */
  formatVersion?: number;
};

/** The most recent auto-download outcome, kept so failures are visible. */
export type LastDownloadEvent = {
  trackId: string;
  title: string;
  success: boolean;
  /** Short human-readable reason when the attempt failed. */
  reason?: string;
  at: number;
};

/** A position jump larger than wall-clock + this is a seek, not listening. */
const SEEK_TOLERANCE_SECONDS = 2;
/** Fraction of the duration that must be listened before auto-download. */
const DOWNLOAD_TRIGGER_RATIO = 0.5;
/** A failed download is not retried more often than this. */
const RETRY_BACKOFF_MS = 60_000;

type PlaybackObservation = {
  isPlaying: boolean;
  /** Seconds. */
  position: number;
  /** Seconds; 0 until known. */
  duration: number;
};

class DownloadServiceImpl {
  private listening = new Map<string, ListeningRecord>();
  private downloads = new Map<string, DownloadedTrack>();
  private downloading = new Set<string>();
  private lastFailedAt = new Map<string, number>();
  private completeListeners = new Set<(record: DownloadedTrack) => void>();
  private lastEvent: LastDownloadEvent | null = null;

  private loadPromise: Promise<void> | null = null;

  // ---- per-play session state (in-memory only) ----
  private sessionKey: unknown = null;
  private sessionTrackId: string | null = null;
  private lastPosition = 0;
  private lastStamp = 0;
  /** Seconds counted toward the listening total within the current play. */
  private sessionCounted = 0;

  load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.performLoad();
    return this.loadPromise;
  }

  private async performLoad(): Promise<void> {
    const [listening, downloads, lastEvent] = await Promise.all([
      readJson<Record<string, ListeningRecord>>(STORAGE_KEYS.listening, {}),
      readJson<DownloadedTrack[]>(STORAGE_KEYS.downloads, []),
      readJson<LastDownloadEvent | null>(STORAGE_KEYS.downloadEvent, null),
    ]);

    if (listening && typeof listening === 'object') {
      for (const [k, v] of Object.entries(listening)) {
        if (v && typeof v.totalSeconds === 'number') this.listening.set(k, v);
      }
    }

    let droppedLegacy = false;
    if (Array.isArray(downloads)) {
      for (const d of downloads) {
        if (!d?.trackId) continue;
        if (d.encrypted) {
          this.downloads.set(d.trackId, d);
        } else {
          // Phase 1 saved plain audio files. Those are stale test data
          // under the Phase 2 design: drop the record; the files are
          // removed by cleanupLegacyPlainFiles() below. The song simply
          // re-saves, encrypted, on its next qualifying listen.
          droppedLegacy = true;
        }
      }
    }
    if (droppedLegacy) this.persistDownloads();
    this.cleanupLegacyPlainFiles();

    if (lastEvent && typeof lastEvent.at === 'number') {
      this.lastEvent = lastEvent;
    }
  }

  /**
   * Delete plain audio left behind by Phase 1 from the downloads folder.
   * Phase 2's `.esei` ciphertext files live in the same folder (Android's
   * filesDir) and are deliberately left untouched.
   */
  private cleanupLegacyPlainFiles(): void {
    try {
      const dir = new Directory(Paths.document, 'esei-downloads');
      if (!dir.exists) return;
      for (const entry of dir.list()) {
        if (entry instanceof Directory) continue;
        if (!entry.name.endsWith('.esei')) entry.delete();
      }
    } catch {
      // Cleanup is best-effort; a stuck file must never break startup.
    }
  }

  // ---- read API -----------------------------------------------------------

  getListeningTotal(trackId: string): number {
    return this.listening.get(trackId)?.totalSeconds ?? 0;
  }

  getListeningRecords(): ListeningRecord[] {
    return [...this.listening.values()];
  }

  /** The most recent download attempt's outcome, or null if none yet. */
  getLastDownloadEvent(): LastDownloadEvent | null {
    return this.lastEvent;
  }

  isDownloaded(trackId: string): boolean {
    return this.downloads.has(trackId);
  }

  isDownloading(trackId: string): boolean {
    return this.downloading.has(trackId);
  }

  getDownloads(): DownloadedTrack[] {
    return [...this.downloads.values()].sort((a, b) => b.downloadedAt - a.downloadedAt);
  }

  getDownload(trackId: string): DownloadedTrack | undefined {
    return this.downloads.get(trackId);
  }

  totalDownloadedBytes(): number {
    let total = 0;
    for (const d of this.downloads.values()) total += d.fileSize || 0;
    return total;
  }

  /**
   * Tracks on their way to the download trigger: some listening logged,
   * duration known, not yet saved. Sorted by progress so the closest to
   * saving reads first. Powers the Offline section's progress list.
   *
   * A track whose download is in flight stays in this list flagged
   * `saving` — hiding it while it downloaded made a song appear to
   * vanish at the trigger point with nothing to show for it.
   */
  getInProgress(): { record: ListeningRecord; ratio: number; saving: boolean }[] {
    const out: { record: ListeningRecord; ratio: number; saving: boolean }[] = [];
    for (const record of this.listening.values()) {
      if (this.downloads.has(record.trackId)) {
        continue;
      }
      if (record.duration <= 0 || record.totalSeconds <= 0) continue;
      out.push({
        record,
        ratio: Math.min(1, record.totalSeconds / record.duration),
        saving: this.downloading.has(record.trackId),
      });
    }
    return out.sort((a, b) => b.ratio - a.ratio);
  }

  /** Notified once per completed auto-download (drives the "saved" toast). */
  subscribeDownloadComplete(listener: (record: DownloadedTrack) => void): () => void {
    this.completeListeners.add(listener);
    return () => {
      this.completeListeners.delete(listener);
    };
  }

  // ---- offline playback -----------------------------------------------------

  /** Rebuild the app's Track shape from a saved song's record. */
  toTrack(record: DownloadedTrack): Track {
    return {
      id: record.trackId,
      title: record.title,
      artist: { id: `offline:${record.sourceId}`, name: record.artist },
      albumImageUrl: record.albumImageUrl ?? '',
      duration: record.duration || 0,
      provider: 'youtube',
      sourceId: record.sourceId,
    };
  }

  /**
   * A playable stream for a saved song: the native loopback URL that
   * decrypts it on the fly. Null when the file is gone, in which case the
   * stale record is dropped so the song can save again on a later listen.
   */
  async getOfflineStream(record: DownloadedTrack): Promise<ResolvedStream | null> {
    const info = await offlineFileInfo(record.sourceId);
    if (!info.exists) {
      this.downloads.delete(record.trackId);
      this.persistDownloads();
      return null;
    }
    const url = await getOfflinePlaybackUrl(record.sourceId, record.mimeType);
    if (!url) return null;
    return {
      url,
      mimeType: record.mimeType,
      expiresAt: Date.now() + 60 * 60 * 1000,
      resolvedBy: 'offline-encrypted',
    };
  }

  // ---- delete ---------------------------------------------------------------

  /** Remove a saved song: encrypted file first, then its record. */
  async deleteDownload(record: DownloadedTrack): Promise<void> {
    await deleteOfflineFile(record.sourceId);
    this.downloads.delete(record.trackId);
    this.persistDownloads();
  }

  // ---- persistence helpers ----------------------------------------------------

  private persistDownloads(): void {
    // Written immediately, not debounced: Phase 1's debounced write could
    // be lost if the app was killed right after a download completed.
    void writeJson(STORAGE_KEYS.downloads, [...this.downloads.values()]);
  }

  private recordEvent(event: LastDownloadEvent): void {
    this.lastEvent = event;
    void writeJson(STORAGE_KEYS.downloadEvent, event);
  }

  // ---- listening-time tracking ------------------------------------------

  /**
   * Feed every playback status tick here. `sessionKey` identifies one play
   * (the player passes its load id): when it changes, the per-play cap and
   * the position baseline reset.
   */
  observe(track: Track, status: PlaybackObservation, sessionKey: unknown): void {
    const now = Date.now();
    const duration = status.duration || track.duration || 0;

    if (this.sessionKey !== sessionKey || this.sessionTrackId !== track.id) {
      this.sessionKey = sessionKey;
      this.sessionTrackId = track.id;
      this.lastPosition = status.position;
      this.lastStamp = now;
      this.sessionCounted = 0;
      return;
    }

    const positionDelta = status.position - this.lastPosition;
    const wallDelta = (now - this.lastStamp) / 1000;
    this.lastPosition = status.position;
    this.lastStamp = now;

    if (!status.isPlaying || positionDelta <= 0) return;

    // Seeks move the position (near-)instantly; real playback cannot advance
    // faster than the clock. Discard the jump rather than counting it.
    if (positionDelta > wallDelta + SEEK_TOLERANCE_SECONDS) return;

    let counted = positionDelta;
    if (duration > 0) {
      // At most one full duration per play counts toward the total.
      counted = Math.min(counted, Math.max(0, duration - this.sessionCounted));
    }
    if (counted <= 0) return;
    this.sessionCounted += counted;

    const existing = this.listening.get(track.id);
    const total = (existing?.totalSeconds ?? 0) + counted;
    this.listening.set(track.id, {
      trackId: track.id,
      totalSeconds: total,
      duration: duration || existing?.duration || 0,
      title: track.title,
      artist: track.artist.name,
      updatedAt: now,
    });
    writeJsonDebounced(
      STORAGE_KEYS.listening,
      Object.fromEntries(this.listening),
      1000
    );

    if (duration > 0 && total >= duration * DOWNLOAD_TRIGGER_RATIO) {
      void this.maybeDownload(track);
    }
  }

  // ---- auto-download -----------------------------------------------------

  /**
   * Save a track's audio, encrypted, once. Safe to call on every tick past
   * the trigger: downloaded/downloading tracks and a post-failure backoff
   * make repeat calls cheap no-ops.
   */
  async maybeDownload(track: Track): Promise<void> {
    await this.load();

    if (this.downloads.has(track.id) || this.downloading.has(track.id)) return;

    const failedAt = this.lastFailedAt.get(track.id);
    if (failedAt && Date.now() - failedAt < RETRY_BACKOFF_MS) return;

    this.downloading.add(track.id);
    try {
      // Always resolve fresh for a download: the URL used for playback may
      // be near its expiry, and a download outlives the playback session.
      MusicService.invalidateStream(track);
      const stream = await MusicService.resolveStream(track);

      // Native code streams the bytes through the encryptor: the only file
      // this creates is ciphertext, in app-private storage.
      const result = await downloadAndEncryptStream(
        stream.url,
        stream.headers ?? {},
        track.sourceId
      );
      if (!result.ok) throw new Error(result.message);

      const record: DownloadedTrack = {
        trackId: track.id,
        sourceId: track.sourceId,
        title: track.title,
        artist: track.artist.name,
        albumImageUrl: track.albumImageUrl || undefined,
        duration: track.duration || 0,
        filePath: result.path,
        fileSize: result.fileSize,
        mimeType: stream.mimeType,
        downloadedAt: Date.now(),
        listeningSeconds: this.getListeningTotal(track.id),
        encrypted: true,
        formatVersion: 1,
      };

      this.downloads.set(track.id, record);
      this.persistDownloads();
      this.recordEvent({
        trackId: track.id,
        title: track.title,
        success: true,
        at: Date.now(),
      });

      if (__DEV__) {
        console.log('[downloads] saved (encrypted)', record.title, record.fileSize, 'bytes');
      }
      for (const listener of this.completeListeners) listener(record);
    } catch (e) {
      this.lastFailedAt.set(track.id, Date.now());
      // Failures are no longer silent (Phase 1's were): the Offline section
      // shows this event until a later attempt replaces it. The trigger
      // stays true, so a later tick retries after the backoff.
      this.recordEvent({
        trackId: track.id,
        title: track.title,
        success: false,
        reason: e instanceof Error ? e.message : String(e),
        at: Date.now(),
      });
      if (__DEV__) console.log('[downloads] failed', track.title, e);
    } finally {
      this.downloading.delete(track.id);
    }
  }
}

export const DownloadService = new DownloadServiceImpl();
