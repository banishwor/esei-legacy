import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Lock, Trash2 } from 'lucide-react-native';
import { COLORS, FONTS, SIZES } from '../../constants/theme';
import { usePlayer } from '../../hooks/usePlayer';
import { useLibrary } from '../../hooks/useLibrary';
import { isDebugUnlocked } from '../../core/debug';
import {
  DownloadService,
  DownloadedTrack,
  LastDownloadEvent,
  ListeningRecord,
} from '../../services/DownloadService';

/**
 * The Offline section (Phase 2), shown under the Library's "Offline" filter.
 *
 * Saved songs are stored encrypted and can only be played inside Esei --
 * that is stated on the section itself, not just in the README. The section
 * also answers Phase 1's "I don't see" problem two ways: songs still on
 * their way to the 50% save point show their listening progress, and the
 * last save attempt's outcome (including failures, with the reason) is
 * shown as a status line instead of failing silently.
 */

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDate(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

function formatWhen(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return formatDate(epochMs);
}

export const OfflineSection: React.FC = () => {
  const { playOffline, currentTrack, isPlaying } = usePlayer();
  const { profile } = useLibrary();
  const debugUnlocked = isDebugUnlocked(profile.name);
  const [downloads, setDownloads] = useState<DownloadedTrack[]>([]);
  const [inProgress, setInProgress] = useState<
    { record: ListeningRecord; ratio: number; saving: boolean }[]
  >([]);
  const [lastEvent, setLastEvent] = useState<LastDownloadEvent | null>(null);
  const [events, setEvents] = useState<LastDownloadEvent[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    await DownloadService.load();
    if (!mounted.current) return;
    setDownloads(DownloadService.getDownloads());
    setInProgress(DownloadService.getInProgress());
    setLastEvent(DownloadService.getLastDownloadEvent());
    setEvents(DownloadService.getDownloadEvents());
    setTotalBytes(DownloadService.totalDownloadedBytes());
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Listening progress moves while the user listens elsewhere in the app,
  // so refresh on focus and keep ticking over while the section is visible.
  useFocusEffect(
    useCallback(() => {
      void refresh();
      const timer = setInterval(() => void refresh(), 2000);
      return () => clearInterval(timer);
    }, [refresh])
  );

  const onDelete = useCallback(
    (record: DownloadedTrack) => {
      Alert.alert(
        'Remove saved song?',
        `"${record.title}" will be removed from this phone. It saves again if you listen past halfway.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                await DownloadService.deleteDownload(record);
                await refresh();
              })();
            },
          },
        ]
      );
    },
    [refresh]
  );

  const onPlay = useCallback(
    (record: DownloadedTrack) => playOffline(record),
    [playOffline]
  );

  return (
    <View>
      <Text style={styles.summary}>
        {downloads.length
          ? `${downloads.length} ${downloads.length === 1 ? 'song' : 'songs'} • ${formatBytes(totalBytes)} on this phone`
          : 'Songs you listen to past halfway are saved here.'}
      </Text>
      <View style={styles.noteRow}>
        <Lock color={COLORS.text.muted} size={13} />
        <Text style={styles.note}>
          Saved songs are encrypted and play only inside Esei.
        </Text>
      </View>

      {lastEvent && (
        <Text
          style={[
            styles.eventLine,
            lastEvent.success ? styles.eventOk : styles.eventFailed,
          ]}
          numberOfLines={2}
        >
          {lastEvent.success
            ? `Saved "${lastEvent.title}" • ${formatWhen(lastEvent.at)}`
            : `Couldn't save "${lastEvent.title}" (${lastEvent.reason ?? 'unknown error'}) • ${formatWhen(lastEvent.at)}`}
        </Text>
      )}

      {downloads.map((record) => {
        const active = currentTrack?.id === record.trackId;
        const meta = [
          record.artist,
          formatDuration(record.duration),
          formatBytes(record.fileSize),
          formatDate(record.downloadedAt),
        ]
          .filter(Boolean)
          .join(' • ');
        return (
          <TouchableOpacity
            key={record.trackId}
            style={styles.row}
            activeOpacity={0.7}
            onPress={() => onPlay(record)}
          >
            {record.albumImageUrl ? (
              <Image source={{ uri: record.albumImageUrl }} style={styles.image} />
            ) : (
              <View style={styles.image} />
            )}
            <View style={styles.info}>
              <Text
                style={[styles.title, active && isPlaying && styles.titleActive]}
                numberOfLines={1}
              >
                {record.title}
              </Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {meta}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.deleteButton}
              onPress={() => onDelete(record)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Trash2 color={COLORS.text.muted} size={18} />
            </TouchableOpacity>
          </TouchableOpacity>
        );
      })}

      {inProgress.length > 0 && (
        <View style={styles.progressSection}>
          <Text style={styles.sectionLabel}>ON THE WAY TO SAVING</Text>
          {inProgress.map(({ record, ratio, saving }) => (
            <View key={record.trackId} style={styles.progressRow}>
              <View style={styles.info}>
                <Text style={styles.title} numberOfLines={1}>
                  {record.title ?? 'Unknown title'}
                </Text>
                <Text style={styles.subtitle} numberOfLines={1}>
                  {saving
                    ? 'Saving now — encrypting to this phone…'
                    : `${record.artist ? `${record.artist} • ` : ''}${Math.floor(ratio * 100)}% listened — saves at 50%${debugUnlocked ? ` • ${Math.round(record.totalSeconds)}s of ${record.duration}s` : ''}`}
                </Text>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: saving
                          ? '100%'
                          : `${Math.min(100, Math.max(2, ratio * 100))}%`,
                        opacity: saving ? 0.45 : 1,
                      },
                    ]}
                  />
                </View>
              </View>
            </View>
          ))}
        </View>
      )}

      {!downloads.length && !inProgress.length && (
        <Text style={styles.emptyHint}>
          Nothing saved yet. Play a song and listen past halfway — seeking
          forward doesn't count — and it will appear here, ready to play with
          no internet at all.
        </Text>
      )}

      {debugUnlocked && events.length > 0 && (
        <View style={styles.progressSection}>
          <Text style={styles.sectionLabel}>SAVE LOG (DEBUG)</Text>
          {events.slice(0, 10).map((e, i) => (
            <Text key={`${e.at}-${i}`} style={styles.subtitle} numberOfLines={2}>
              {new Date(e.at).toLocaleTimeString()}{' '}
              {e.success ? '✓ Saved' : `✗ Failed`} "{e.title}"
              {e.reason ? ` — ${e.reason}` : ''}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  summary: {
    fontFamily: FONTS.medium,
    fontSize: 15,
    color: COLORS.text.primary,
    marginBottom: SIZES.xs,
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SIZES.md,
  },
  note: {
    fontFamily: FONTS.regular,
    fontSize: 12.5,
    color: COLORS.text.muted,
    marginLeft: 5,
  },
  eventLine: {
    fontFamily: FONTS.regular,
    fontSize: 12.5,
    marginBottom: SIZES.md,
  },
  eventOk: {
    color: COLORS.accent.green,
  },
  eventFailed: {
    color: COLORS.accent.red,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SIZES.md,
    paddingVertical: SIZES.xs,
  },
  image: {
    width: 56,
    height: 56,
    borderRadius: SIZES.radius.sm,
    backgroundColor: COLORS.surfaceLight,
  },
  info: {
    flex: 1,
    marginLeft: SIZES.md,
    justifyContent: 'center',
  },
  title: {
    fontFamily: FONTS.medium,
    fontSize: 15.5,
    color: COLORS.text.primary,
    marginBottom: 3,
  },
  titleActive: {
    color: COLORS.accent.green,
  },
  subtitle: {
    fontFamily: FONTS.regular,
    fontSize: 13,
    color: COLORS.text.secondary,
  },
  deleteButton: {
    padding: SIZES.sm,
  },
  progressSection: {
    marginTop: SIZES.md,
  },
  sectionLabel: {
    fontFamily: FONTS.medium,
    fontSize: 11.5,
    letterSpacing: 1,
    color: COLORS.text.muted,
    marginBottom: SIZES.sm,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SIZES.md,
  },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: COLORS.player.progressTrack,
    marginTop: 7,
    overflow: 'hidden',
  },
  progressFill: {
    height: 3,
    borderRadius: 2,
    backgroundColor: COLORS.text.primary,
  },
  emptyHint: {
    fontFamily: FONTS.regular,
    fontSize: 14,
    color: COLORS.text.muted,
    paddingVertical: SIZES.sm,
    lineHeight: 20,
  },
});
