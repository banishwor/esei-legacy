import { registerWebModule, NativeModule } from 'expo';

import {
  EncryptedDownloadResult,
  NativeStreamResult,
  OfflineFileInfo,
  PlatformInfo,
} from './NoteNative.types';

class NoteNativeModule extends NativeModule<{}> {
  getPlatformInfo(): PlatformInfo {
    return { platform: 'web', native: false };
  }

  /** There is no extractor on web; callers fall through to the next source. */
  async resolveYouTubeStream(): Promise<NativeStreamResult> {
    return {
      ok: false,
      reason: 'module_unavailable',
      message: 'Native stream resolution is not available on web',
    };
  }

  /** Encrypted offline storage is Android-only. */
  async downloadAndEncrypt(): Promise<EncryptedDownloadResult> {
    return {
      ok: false,
      message: 'Encrypted offline storage is not available on web',
    };
  }

  async getOfflinePlaybackUrl(): Promise<string | null> {
    return null;
  }

  async deleteOfflineFile(): Promise<boolean> {
    return false;
  }

  async offlineFileInfo(): Promise<OfflineFileInfo> {
    return { exists: false, size: 0 };
  }
}

export default registerWebModule(NoteNativeModule, 'NoteNativeModule');
