import { AppState } from 'react-native';
import { addConnectivityListener, getOnlineStatus } from '../../modules/note-native';

/**
 * Connectivity for Phase 3's offline modes (offline Home, local Search).
 *
 * The reading comes from the existing native module (ConnectivityManager),
 * not a new dependency. Three signals keep it fresh:
 *
 *   - the native `onConnectivityChanged` event while anyone is subscribed
 *     (airplane mode toggled with the app open),
 *   - a re-check whenever the app returns to the foreground,
 *   - explicit `check()` calls from screens on focus.
 *
 * Until a first real reading exists the service reports ONLINE: offline
 * mode is a fallback, and a wrong "offline" on a healthy connection would
 * hide the whole catalogue. Web / Expo Go (no native module) therefore
 * simply stay online, exactly as the app behaved before Phase 3.
 */
class ConnectivityServiceImpl {
  private lastKnown: boolean | null = null;
  private listeners = new Set<(online: boolean) => void>();
  private started = false;

  /** Last known state; online until a real reading says otherwise. */
  current(): boolean {
    return this.lastKnown ?? true;
  }

  /** Read the native state now, notifying subscribers if it changed. */
  check(): boolean {
    this.ensureStarted();
    const value = getOnlineStatus();
    if (value === null) return this.current();
    this.update(value);
    return value;
  }

  subscribe(listener: (online: boolean) => void): () => void {
    this.ensureStarted();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private update(value: boolean): void {
    if (this.lastKnown === value) return;
    this.lastKnown = value;
    for (const listener of this.listeners) listener(value);
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;

    addConnectivityListener((online) => this.update(online));

    AppState.addEventListener('change', (state) => {
      if (state === 'active') this.check();
    });

    // Prime the cache so current() is a real reading from the start.
    const initial = getOnlineStatus();
    if (initial !== null) this.lastKnown = initial;
  }
}

export const ConnectivityService = new ConnectivityServiceImpl();
