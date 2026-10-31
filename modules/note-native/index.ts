import NoteNativeModule from './src/NoteNativeModule';
import {
  EncryptedDownloadResult,
  NativeStreamResult,
  OfflineFileInfo,
  PlatformInfo,
} from './src/NoteNative.types';

export * from './src/NoteNative.types';
export { default as NoteNativeModule } from './src/NoteNativeModule';

/** True when this binary actually contains the Esei native module. */
export function isNoteNativeAvailable(): boolean {
  return NoteNativeModule != null;
}

/**
 * Proof-of-connection call across the TypeScript -> Kotlin boundary.
 * Returns null instead of throwing when the native module is absent.
 */
export function getPlatformInfo(): PlatformInfo | null {
  return NoteNativeModule?.getPlatformInfo() ?? null;
}

/**
 * Resolve a YouTube video id to a playable progressive audio stream using the
 * native NewPipe Extractor.
 *
 * Never throws: a missing module or a failed extraction both come back as a
 * structured failure result.
 */
export async function resolveYouTubeStream(
  videoId: string
): Promise<NativeStreamResult> {
  const module = NoteNativeModule;
  if (!module) {
    return {
      ok: false,
      reason: 'module_unavailable',
      message: 'NoteNative is not present in this binary',
    };
  }

  try {
    return await module.resolveYouTubeStream(videoId);
  } catch (e) {
    // A bridge-level failure (rather than an extraction failure) still has to
    // arrive as data, not as a thrown error.
    return {
      ok: false,
      reason: 'unknown',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Download a stream straight into encrypted storage (Phase 2).
 *
 * The URL is fetched by native code and written as AES-256-GCM ciphertext;
 * no plain audio file ever exists. Never throws.
 */
export async function downloadAndEncryptStream(
  url: string,
  headers: Record<string, string>,
  sourceId: string
): Promise<EncryptedDownloadResult> {
  const module = NoteNativeModule;
  if (!module) {
    return { ok: false, message: 'NoteNative is not present in this binary' };
  }
  try {
    return await module.downloadAndEncrypt(url, headers, sourceId);
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * The loopback URL the player loads to hear a saved song, or null when the
 * song is not saved. The URL only works from inside this app, in this
 * process, with this session's token.
 */
export async function getOfflinePlaybackUrl(
  sourceId: string,
  mimeType?: string
): Promise<string | null> {
  const module = NoteNativeModule;
  if (!module) return null;
  try {
    return await module.getOfflinePlaybackUrl(sourceId, mimeType ?? null);
  } catch {
    return null;
  }
}

/** Remove a saved song's encrypted file. Returns false when it was absent. */
export async function deleteOfflineFile(sourceId: string): Promise<boolean> {
  const module = NoteNativeModule;
  if (!module) return false;
  try {
    return await module.deleteOfflineFile(sourceId);
  } catch {
    return false;
  }
}

/** Whether a saved song's encrypted file is on disk, and its size. */
export async function offlineFileInfo(
  sourceId: string
): Promise<OfflineFileInfo> {
  const module = NoteNativeModule;
  if (!module) return { exists: false, size: 0 };
  try {
    return await module.offlineFileInfo(sourceId);
  } catch {
    return { exists: false, size: 0 };
  }
}

/**
 * One-shot connectivity read (Phase 3). Null when the native module is
 * absent, so callers can tell "unknown" apart from a real offline reading
 * and keep their previous behaviour.
 */
export function getOnlineStatus(): boolean | null {
  const module = NoteNativeModule;
  if (!module) return null;
  try {
    return module.isOnline();
  } catch {
    return null;
  }
}

/**
 * Subscribe to connectivity changes. Returns an unsubscribe function; a
 * no-op when the native module is absent (callers re-check on focus).
 */
export function addConnectivityListener(
  listener: (online: boolean) => void
): () => void {
  const module = NoteNativeModule;
  if (!module) return () => undefined;
  try {
    const subscription = module.addListener('onConnectivityChanged', (event) => {
      listener(Boolean(event?.online));
    });
    return () => subscription.remove();
  } catch {
    return () => undefined;
  }
}
