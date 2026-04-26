// Tiny wrapper around the Web Vibration API. iOS Safari does not
// implement vibrate at all (silent no-op there); Android Chrome and
// Firefox honour the pattern. Wrapping the call lets the rest of the
// codebase fire-and-forget without sprinkling typeof checks.
//
// Patterns are conventional millisecond values:
//   - 8   subtle tick (modifier toggle, deck card tap)
//   - 12  default success (deploy commit, save)
//   - 25  warning (out-of-zone tap, depleted card)
//   - [40, 30, 40] success arpeggio (raid victory)

let muted = false;

export function setHapticsMuted(value: boolean): void {
  muted = value;
}

export function haptic(pattern: number | number[]): void {
  if (muted) return;
  if (typeof navigator === 'undefined') return;
  // The Web Vibration API ships a `vibrate(VibratePattern)` method,
  // but older lib types restrict the parameter and newer ones widen
  // it — cast through unknown so we don't fight the lib version.
  const nav = navigator as unknown as {
    vibrate?: (p: number | number[]) => boolean;
  };
  if (typeof nav.vibrate !== 'function') return;
  try {
    nav.vibrate(pattern);
  } catch {
    // Some user agents reject patterns >5s — silent fallback.
  }
}
