/**
 * Amiga period values to MIDI note numbers.
 *
 * Lives here rather than in music_lib because the MOD decoder is the only
 * thing that ever sees a period: every other tracker format stores note
 * numbers directly. Converting at the boundary is what keeps "periods are a
 * ProTracker detail" true, and what lets the neutral `TrackerCell` carry a
 * plain note number.
 *
 * **Known limitation:** this computes from a reference period rather than
 * ProTracker's own table, which finetune shifts — so a real module can land a
 * note or two differently than a tracker would show.
 */

/** ProTracker's C-1 period, taken as MIDI 36 (C2). */
const REFERENCE_PERIOD = 856;
const REFERENCE_MIDI = 36;

/** The pitch a period sounds, or null for "no new note". */
export function periodToMidi(period: number): number | null {
  if (period <= 0) return null;
  return Math.round(REFERENCE_MIDI + 12 * Math.log2(REFERENCE_PERIOD / period));
}
