import { NativeModule, requireOptionalNativeModule } from 'expo';

import {
  EncryptedDownloadResult,
  NativeStreamResult,
  NoteNativeModuleEvents,
  OfflineFileInfo,
  PlatformInfo,
} from './NoteNative.types';

declare class NoteNativeModule extends NativeModule<NoteNativeModuleEvents> {
  getPlatformInfo(): PlatformInfo;
  /** Synchronous connectivity read: the active network declares internet. */
  isOnline(): boolean;
  resolveYouTubeStream(videoId: string): Promise<NativeStreamResult>;
  downloadAndEncrypt(
    url: string,
    headers: Record<string, string>,
    sourceId: string
  ): Promise<EncryptedDownloadResult>;
  getOfflinePlaybackUrl(
    sourceId: string,
    mimeType: string | null
  ): Promise<string | null>;
  deleteOfflineFile(sourceId: string): Promise<boolean>;
  offlineFileInfo(sourceId: string): Promise<OfflineFileInfo>;
}

/**
 * Null when the native module is not in the running binary -- Expo Go, or a
 * development build made before this module existed. Callers must handle that,
 * which is why `index.ts` exposes the guarded helpers instead.
 */
export default requireOptionalNativeModule<NoteNativeModule>('NoteNative');
