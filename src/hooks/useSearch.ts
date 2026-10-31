import { useCallback, useEffect, useRef, useState } from 'react';
import { messageFor } from '../core/errors';
import {
  EMPTY_SEARCH_RESULTS,
  SearchFilter,
  SearchResults,
  emptySearchResults,
} from '../core/types';
import { ConnectivityService } from '../services/ConnectivityService';
import { DownloadService } from '../services/DownloadService';
import { LibraryService } from '../services/LibraryService';
import { MusicService } from '../services/MusicService';

const DEBOUNCE_MS = 350;

type UseSearch = {
  query: string;
  setQuery: (q: string) => void;
  filter: SearchFilter;
  setFilter: (f: SearchFilter) => void;
  results: SearchResults;
  suggestions: string[];
  isSearching: boolean;
  error: string | null;
  /** True while results come from the local saved songs (no internet). */
  isOffline: boolean;
  /** Run a search immediately, bypassing the debounce (category taps, submit). */
  searchNow: (q: string, filter?: SearchFilter) => void;
  retry: () => void;
  clear: () => void;
  hasResults: boolean;
};

/**
 * Debounced search against MusicService.
 *
 * Every keystroke aborts the previous request, so a fast typist issues one
 * network call rather than one per character, and a stale response can never
 * overwrite a newer one.
 */
export function useSearch(): UseSearch {
  const [query, setQueryState] = useState('');
  const [filter, setFilterState] = useState<SearchFilter>('All');
  const [results, setResults] = useState<SearchResults>(EMPTY_SEARCH_RESULTS);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);
  /** The query/filter actually in flight, so retry() can repeat it. */
  const active = useRef<{ q: string; filter: SearchFilter }>({ q: '', filter: 'All' });

  const run = useCallback(async (q: string, f: SearchFilter) => {
    const trimmed = q.trim();

    abortRef.current?.abort();

    if (!trimmed) {
      setResults(EMPTY_SEARCH_RESULTS);
      setSuggestions([]);
      setIsSearching(false);
      setError(null);
      return;
    }

    const id = ++requestId.current;
    const controller = new AbortController();
    abortRef.current = controller;
    active.current = { q: trimmed, filter: f };

    setIsSearching(true);
    setError(null);

    // Phase 3: with no internet, search runs locally over the saved
    // songs instead of failing. Their rows play through storage-first
    // playback, so local results are fully playable offline.
    if (!ConnectivityService.check()) {
      setIsOffline(true);
      await DownloadService.load();
      if (id !== requestId.current) return; // superseded while loading

      const local = emptySearchResults(trimmed);
      if (f === 'All' || f === 'Songs') {
        local.tracks = DownloadService.searchSaved(trimmed);
      }
      setResults(local);
      setIsSearching(false);
      return;
    }
    setIsOffline(false);

    try {
      const found = await MusicService.search(trimmed, {
        filter: f,
        signal: controller.signal,
      });

      if (id !== requestId.current) return; // a newer search superseded this

      setResults(found);
      setIsSearching(false);
      LibraryService.recordSearch(trimmed);
    } catch (e) {
      if (id !== requestId.current || controller.signal.aborted) return;

      setIsSearching(false);
      setResults(EMPTY_SEARCH_RESULTS);
      setError(messageFor(e));
    }
  }, []);

  // Debounced reaction to typing / filter changes.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = query.trim();
    if (!trimmed) {
      abortRef.current?.abort();
      requestId.current++;
      setResults(EMPTY_SEARCH_RESULTS);
      setSuggestions([]);
      setIsSearching(false);
      setError(null);
      return;
    }

    // Show the spinner straight away; the request itself waits for the pause.
    setIsSearching(true);

    debounceRef.current = setTimeout(() => {
      void run(trimmed, filter);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, filter, run]);

  // Suggestions are fetched separately and never block results.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }

    // No suggestions offline: there is nothing local to suggest from.
    if (!ConnectivityService.current()) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      const found = await MusicService.getSuggestions(trimmed).catch(() => []);
      if (!cancelled) setSuggestions(found);
    }, DEBOUNCE_MS + 100);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Follow connectivity while the screen is alive: going offline swaps
  // an in-flight intent to local search; coming back online re-runs the
  // same query against the network so results upgrade on their own.
  const wasOffline = useRef(false);
  useEffect(() => {
    const onlineNow = ConnectivityService.check();
    wasOffline.current = !onlineNow;
    setIsOffline(!onlineNow);
    return ConnectivityService.subscribe((online) => {
      if (!online) {
        wasOffline.current = true;
        setIsOffline(true);
        if (active.current.q) void run(active.current.q, active.current.filter);
      } else if (wasOffline.current) {
        wasOffline.current = false;
        if (active.current.q) void run(active.current.q, active.current.filter);
      }
    });
  }, [run]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  const searchNow = useCallback(
    (q: string, f?: SearchFilter) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setQueryState(q);
      if (f) setFilterState(f);
      void run(q, f ?? filter);
    },
    [filter, run]
  );

  const retry = useCallback(() => {
    void run(active.current.q, active.current.filter);
  }, [run]);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    requestId.current++;
    setQueryState('');
    setResults(EMPTY_SEARCH_RESULTS);
    setSuggestions([]);
    setError(null);
    setIsSearching(false);
  }, []);

  const hasResults =
    results.tracks.length > 0 ||
    results.artists.length > 0 ||
    results.albums.length > 0 ||
    results.playlists.length > 0;

  return {
    query,
    setQuery: setQueryState,
    filter,
    setFilter: setFilterState,
    results,
    suggestions,
    isSearching,
    error,
    isOffline,
    searchNow,
    retry,
    clear,
    hasResults,
  };
}
