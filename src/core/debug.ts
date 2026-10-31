/**
 * Hidden debug mode for hands-on testing (Banishwor's idea, 2026-10-31).
 *
 * Setting the profile name to "Bani" in Settings unlocks the debug tools:
 * a DEBUG section in Settings (force-save the current song, reset
 * listening progress, delete all saved songs) and extra detail in the
 * Offline section (exact listened seconds and the save-attempt log).
 *
 * This is a convenience switch for the maintainer's own testing, not a
 * security feature: anyone can type the name, and the tools only touch
 * the app's own listening/download data.
 */
export function isDebugUnlocked(profileName?: string | null): boolean {
  return (profileName ?? '').trim().toLowerCase() === 'bani';
}
