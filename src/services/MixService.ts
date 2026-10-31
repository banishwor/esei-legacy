import { Track } from '../core/types';
import { DownloadService, DownloadedTrack, ListeningRecord } from './DownloadService';
import { LibraryService } from './LibraryService';

/**
 * "Your Mixes" for Home (Phase 3.2): playlists the app builds by itself
 * from what is already on the phone -- listening totals, likes, history
 * and saved songs. Nothing here touches the network, so the mixes are
 * identical online and offline; a mix that reaches the player simply
 * plays its saved tracks from local storage and skips the rest.
 *
 * A mix is only offered when it has at least MIN_TRACKS tracks. A card
 * with one or two songs is a worse Home than no card, so thin mixes are
 * omitted rather than padded.
 */

export type MixId =
  | 'most-played'
  | 'liked-mix'
  | 'forgotten-favourites'
  | 'recently-saved';

export type Mix = {
  id: MixId;
  title: string;
  /** True when tapping the card should start the mix shuffled. */
  shuffleOnPlay: boolean;
  tracks: Track[];
};

const MIN_TRACKS = 3;
/** Long enough to feel like a mix, short enough to stay a queue, not a dump. */
const MAX_TRACKS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Not played in a month is what "forgotten" means here. */
const FORGOTTEN_AFTER_MS = 30 * DAY_MS;
/**
 * The weakest listening signal still trusted as a favourite: a minute of
 * real listening. The tracker discards seeks, so this is honest time --
 * a song someone kept skipping past never reaches it.
 */
const MEANINGFUL_LISTENING_SECONDS = 60;

class MixServiceImpl {
  async buildMixes(): Promise<Mix[]> {
    await Promise.all([DownloadService.load(), LibraryService.load()]);

    const downloads = DownloadService.getDownloads();
    const listening = DownloadService.getListeningRecords();
    const liked = LibraryService.getLiked();
    const history = LibraryService.getHistory();
    const recents = LibraryService.getRecentlyPlayed();

    // ---- shared lookups -------------------------------------------------

    /**
     * Best display metadata per track id. Filled weakest-first so the
     * strongest source wins: a listening record knows only title/artist,
     * while history, recents, likes and downloads carry full Tracks.
     */
    const trackById = new Map<string, Track>();
    for (const record of listening) {
      const synth = trackFromListening(record);
      if (synth) trackById.set(synth.id, synth);
    }
    // History is newest-first; write oldest-first so the newest entry's
    // metadata (freshest artwork/title) is what survives.
    for (let i = history.length - 1; i >= 0; i--) {
      trackById.set(history[i].track.id, history[i].track);
    }
    for (let i = recents.length - 1; i >= 0; i--) {
      trackById.set(recents[i].id, recents[i]);
    }
    for (const track of liked) trackById.set(track.id, track);
    const downloadById = new Map<string, DownloadedTrack>();
    for (const record of downloads) {
      downloadById.set(record.trackId, record);
      trackById.set(record.trackId, DownloadService.toTrack(record));
    }

    /** Most recent real listen per track, from the history log. */
    const lastPlayedAt = new Map<string, number>();
    for (const entry of history) {
      if (!lastPlayedAt.has(entry.track.id)) {
        lastPlayedAt.set(entry.track.id, entry.playedAt);
      }
    }

    const listeningById = new Map(listening.map((r) => [r.trackId, r]));

    // ---- the mixes ------------------------------------------------------

    const mostPlayed: Mix = {
      id: 'most-played',
      title: 'Most Played',
      shuffleOnPlay: false,
      tracks: [...listening]
        .filter((r) => r.totalSeconds > 0)
        .sort((a, b) => b.totalSeconds - a.totalSeconds)
        .map((r) => trackById.get(r.trackId))
        .filter((t): t is Track => !!t)
        .slice(0, MAX_TRACKS),
    };

    const likedMix: Mix = {
      id: 'liked-mix',
      title: 'Liked Mix',
      shuffleOnPlay: true,
      tracks: liked.slice(0, MAX_TRACKS),
    };

    // Forgotten Favourites: loved once (real listening, a like, or a
    // save), untouched for 30+ days. Last-played comes from history; a
    // track with no history entry falls back to when it was saved (a
    // saved song necessarily arrived through listening), and a liked
    // track with neither counts as long-forgotten.
    const now = Date.now();
    const candidateIds = new Set<string>();
    for (const record of listening) {
      if (record.totalSeconds >= MEANINGFUL_LISTENING_SECONDS) {
        candidateIds.add(record.trackId);
      }
    }
    for (const track of liked) candidateIds.add(track.id);
    for (const record of downloads) candidateIds.add(record.trackId);

    const forgottenTracks = [...candidateIds]
      .map((id) => ({
        id,
        lastPlayed:
          lastPlayedAt.get(id) ?? downloadById.get(id)?.downloadedAt ?? 0,
        seconds: listeningById.get(id)?.totalSeconds ?? 0,
      }))
      .filter((c) => now - c.lastPlayed >= FORGOTTEN_AFTER_MS)
      // Most-loved first underneath the shuffle, so a partial play of
      // the mix still starts from real favourites.
      .sort((a, b) => b.seconds - a.seconds)
      .map((c) => trackById.get(c.id))
      .filter((t): t is Track => !!t)
      .slice(0, MAX_TRACKS);

    const forgottenFavourites: Mix = {
      id: 'forgotten-favourites',
      title: 'Forgotten Favourites',
      shuffleOnPlay: true,
      tracks: forgottenTracks,
    };

    const recentlySaved: Mix = {
      id: 'recently-saved',
      title: 'Recently Saved',
      shuffleOnPlay: false,
      // getDownloads() is already newest-first by downloadedAt.
      tracks: downloads.slice(0, MAX_TRACKS).map((d) => DownloadService.toTrack(d)),
    };

    // Fixed card order; thin mixes drop out instead of padding.
    return [mostPlayed, likedMix, forgottenFavourites, recentlySaved].filter(
      (mix) => mix.tracks.length >= MIN_TRACKS
    );
  }
}

/**
 * Rebuild a playable Track from a listening record alone. Records from
 * before Phase 2 carry no title/artist; those return null and the track
 * is skipped -- a mix card cannot honestly name a song it cannot name.
 */
function trackFromListening(record: ListeningRecord): Track | null {
  if (!record.title) return null;
  const sep = record.trackId.indexOf(':');
  if (sep < 0) return null;

  return {
    id: record.trackId,
    title: record.title,
    artist: { id: '', name: record.artist ?? 'Unknown artist' },
    albumImageUrl: '',
    duration: record.duration || 0,
    provider: 'youtube',
    sourceId: record.trackId.slice(sep + 1),
  };
}

export const MixService = new MixServiceImpl();
