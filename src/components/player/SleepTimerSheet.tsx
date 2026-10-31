import React from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Modal } from 'react-native';
import { X, Check } from 'lucide-react-native';
import { BlurView } from 'expo-blur';
import { COLORS, SIZES, FONTS } from '../../constants/theme';
import { usePlayer } from '../../hooks/usePlayer';

const MINUTE_OPTIONS = [5, 10, 15, 20, 30, 45, 60];

/**
 * Sleep timer options, opened from the moon button in Now Playing.
 *
 * The timer itself lives in the player (usePlayer): a wall-clock countdown
 * that pauses playback when it fires, or an "end of current song" flag the
 * track-end handler honours. This sheet only arms / cancels it.
 */
export const SleepTimerSheet: React.FC<{ visible: boolean; onClose: () => void }> = ({
  visible,
  onClose,
}) => {
  const { sleepTimer, setSleepTimer } = usePlayer();

  const choose = (option: number | 'endOfTrack' | null) => {
    setSleepTimer(option);
    onClose();
  };

  const status =
    sleepTimer.mode === 'minutes'
      ? `Playback will pause in ${sleepTimer.minutes} minutes.`
      : sleepTimer.mode === 'endOfTrack'
        ? 'Playback will pause when this song ends.'
        : null;

  const renderRow = (
    label: string,
    active: boolean,
    onPress: () => void,
    key?: string
  ) => (
    <TouchableOpacity
      key={key ?? label}
      style={styles.row}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text style={[styles.rowLabel, active && styles.rowLabelActive]}>{label}</Text>
      {active && <Check color={COLORS.accent.green} size={18} />}
    </TouchableOpacity>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />

        <BlurView intensity={40} tint="dark" style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Sleep timer</Text>
            <TouchableOpacity onPress={onClose}>
              <X color={COLORS.text.secondary} size={20} />
            </TouchableOpacity>
          </View>

          {status && <Text style={styles.status}>{status}</Text>}

          {renderRow('Off', sleepTimer.mode === 'off', () => choose(null))}
          {MINUTE_OPTIONS.map((m) =>
            renderRow(
              `${m} minutes`,
              sleepTimer.mode === 'minutes' && sleepTimer.minutes === m,
              () => choose(m),
              `m-${m}`
            )
          )}
          {renderRow(
            'End of current song',
            sleepTimer.mode === 'endOfTrack',
            () => choose('endOfTrack')
          )}
        </BlurView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: SIZES.radius.lg,
    borderTopRightRadius: SIZES.radius.lg,
    borderWidth: 1,
    borderColor: COLORS.glassBorder,
    padding: SIZES.lg,
    paddingBottom: SIZES.xl,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SIZES.sm,
  },
  title: {
    fontFamily: FONTS.medium,
    fontSize: 18,
    color: COLORS.text.primary,
  },
  status: {
    fontFamily: FONTS.regular,
    fontSize: 13,
    color: COLORS.accent.green,
    marginBottom: SIZES.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SIZES.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.glassBorder,
  },
  rowLabel: {
    fontFamily: FONTS.regular,
    fontSize: 15,
    color: COLORS.text.primary,
  },
  rowLabelActive: {
    fontFamily: FONTS.medium,
    color: COLORS.accent.green,
  },
});
