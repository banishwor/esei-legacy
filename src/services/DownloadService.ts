import { Directory, File, Paths } from 'expo-file-system';
import { readJson, writeJsonDebounced, STORAGE_KEYS } from '../core/storage';
import { Track } from '../core/types';
import { MusicService } from './MusicService';

/**
 * Phase 1: listening-time tracking + auto-download.
 *
 * Two persistent stores, both keyed by the composite track id
 * (`<provider>:<sourceId>`), so Phase 2 (Offline section) and Phase 3
 * (storage-first playback, 3 GB eviction) can join them by id:
 *
 *   listening  trackId -> total seconds actually listened. This total is the
 *              eviction score Phase 3 will rank downloads by.
 *   downloads  trackId -> the downloaded file and its metadata.
 *
 * "Actually listened" is measured from playback position deltas while the
 * player reports playing, cross-checked against wall-clock time: a seek
 * moves the position far faster than real time, so the jump is discarded
 * instead of counted. Within one play (one load of a track) at most one
 * full duration is counted, so looping or scrubbing back and replaying a
 * section cannot inflate the score past the track's length per play.
 */

export type ListeningRecord = {
  trackId: string;
  /** Total seconds listened across all plays. */
  totalSeconds: number;
  /** Last known duration in seconds (0 when unknown). */
  duration: number;
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
  /** file:// URI of the local audio file. */
  filePath: string;
  fileSize: number;
  mimeType?: string;
  downloadedAt: number;
  /** Listening total at the moment the download completed. */
  listeningSeconds: number;
};

/** A position jump larger than wall-clock + this is a seek, not listening. */
const SEEK_TOLERANCE_SECONDS = 2;
/** Fraction of the duration that must be listened before auto-download. */
const DOWNLOAD_TRIGGER_RATIO = 0.5;
/** A failed download is not retried more often than this. */
const RETRY_BACKOFF_MS = 60_000;

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

function extensionFor(mimeType?: string): string {
  if (mimeType) {
    const clean = mimeType.split(';')[0].trim().toLowerCase();
    if (MIME_EXTENSIONS[clean]) return MIME_EXTENSIONS[clean];
    const subtype = clean.split('/')[1]?.replace(/[^a-z0-9]/g, '');
    if (subtype && subtype.length <= 5) return subtype;
  }
  return 'm4a';
}

/** File names come from source ids; strip anything a filesystem would reject. */
function safeFileBase(sourceId: string): string {
  return sourceId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

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
    const [listening, downloads] = await Promise.all([
      readJson<Record<string, ListeningRecord>>(STORAGE_KEYS.listening, {}),
      readJson<DownloadedTrack[]>(STORAGE_KEYS.downloads, []),
    ]);

    if (listening && typeof listening === 'object') {
      for (const [k, v] of Object.entries(listening)) {
        if (v && typeof v.totalSeconds === 'number') this.listening.set(k, v);
      }
    }
    if (Array.isArray(downloads)) {
      for (const d of downloads) {
        if (d?.trackId) this.downloads.set(d.trackId, d);
      }
    }
  }

  // ---- read API for later phases ---------------------------------------

  getListeningTotal(trackId: string): number {
    return this.listening.get(trackId)?.totalSeconds ?? 0;
  }

  getListeningRecords(): ListeningRecord[] {
    return [...this.listening.values()];
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

  /** Notified once per completed auto-download (drives the "saved" toast). */
  subscribeDownloadComplete(listener: (record: DownloadedTrack) => void): () => void {
    this.completeListeners.add(listener);
    return () => {
      this.completeListeners.delete(listener);
    };
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
   * Download a track's audio to the app's document directory, once. Safe to
   * call on every tick past the trigger: downloaded/downloading tracks and a
   * post-failure backoff make repeat calls cheap no-ops.
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

      const dir = this.downloadsDirectory();
      const destination = new File(
        dir,
        `${safeFileBase(track.sourceId)}.${extensionFor(stream.mimeType)}`
      );
      // A partial file from an earlier interrupted attempt must not be
      // mistaken for (or appended to) the real download.
      if (destination.exists) destination.delete();

      const file = await File.downloadFileAsync(stream.url, destination, {
        headers: stream.headers,
      });

      const record: DownloadedTrack = {
        trackId: track.id,
        sourceId: track.sourceId,
        title: track.title,
        artist: track.artist.name,
        albumImageUrl: track.albumImageUrl || undefined,
        duration: track.duration || 0,
        filePath: file.uri,
        fileSize: file.size,
        mimeType: stream.mimeType,
        downloadedAt: Date.now(),
        listeningSeconds: this.getListeningTotal(track.id),
      };

      this.downloads.set(track.id, record);
      writeJsonDebounced(STORAGE_KEYS.downloads, [...this.downloads.values()], 400);

      if (__DEV__) {
        console.log('[downloads] saved', record.title, record.fileSize, 'bytes');
      }
      for (const listener of this.completeListeners) listener(record);
    } catch (e) {
      this.lastFailedAt.set(track.id, Date.now());
      if (__DEV__) console.log('[downloads] failed', track.title, e);
      // Silent by design: auto-download is a background convenience, and the
      // trigger stays true, so a later tick retries after the backoff.
    } finally {
      this.downloading.delete(track.id);
    }
  }

  private downloadsDirectory(): Directory {
    const dir = new Directory(Paths.document, 'esei-downloads');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    return dir;
  }
}

export const DownloadService = new DownloadServiceImpl();
