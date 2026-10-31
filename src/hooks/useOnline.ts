import { useEffect, useState } from 'react';
import { ConnectivityService } from '../services/ConnectivityService';

/**
 * Reactive online/offline state for screens. Re-checks on mount and then
 * follows the ConnectivityService: native change events, foreground
 * returns, and any explicit check() elsewhere all flow through here.
 * Screens that want a focus-time refresh can call
 * ConnectivityService.check() in their own useFocusEffect.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(() => ConnectivityService.current());

  useEffect(() => {
    setOnline(ConnectivityService.check());
    return ConnectivityService.subscribe(setOnline);
  }, []);

  return online;
}
