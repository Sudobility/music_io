/**
 * ProTracker-style effects, reduced to what notation import uses.
 *
 * Which is very little: speed, tempo and the pattern break. Portamento,
 * vibrato and arpeggio shape a performance, not a score, and the neutral cell
 * has nowhere to put them by design.
 *
 * Shared by MOD and DSM because DSM inherited ProTracker's lettering — it
 * exists largely to carry converted MODs, and the real file this was measured
 * against uses `F` with exactly ProTracker's split. S3M, XM and IT letter their
 * effects differently and will bring their own normalisers.
 */
import type { TrackerCell } from '@sudobility/music_types';

/** Effect F: at or below this the parameter is speed; above it, tempo. */
const SPEED_LIMIT = 0x1f;

export function applyProTrackerEffect(cell: TrackerCell, effect: number, param: number): void {
  if (effect === 0xf) {
    // F00 sets neither knob; trackers treat it as a no-op.
    if (param === 0) return;
    if (param <= SPEED_LIMIT) cell.speed = param;
    else cell.bpm = param;
    return;
  }
  if (effect === 0xd) cell.patternBreak = true;
}
