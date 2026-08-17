/**
 * Scream Tracker 3 commands, reduced to what notation import uses.
 *
 * S3M numbers its commands 1=A through 26=Z, where MOD packs an effect into a
 * nibble — so this cannot share MOD's normaliser, and sharing it behind a
 * format flag would put back exactly the branching the neutral cell exists to
 * remove.
 *
 * The split is also cleaner than MOD's: `A` sets ticks per row and `T` sets
 * BPM, where MOD's single `F` means one or the other depending on whether the
 * parameter clears 0x20.
 *
 * `B` (position jump) is deliberately ignored, as it is for MOD: honouring it
 * can loop forever and a score has no way to express it.
 */
import type { TrackerCell } from '@sudobility/music_types';

/** A = 1: ticks per row. */
const SET_SPEED = 1;
/** C = 3: end this pattern here. */
const PATTERN_BREAK = 3;
/** T = 20: beats per minute. */
const SET_TEMPO = 20;

export function applyS3mEffect(cell: TrackerCell, command: number, info: number): void {
  if (command === SET_SPEED) {
    if (info > 0) cell.speed = info;
    return;
  }
  if (command === SET_TEMPO) {
    if (info > 0) cell.bpm = info;
    return;
  }
  if (command === PATTERN_BREAK) cell.patternBreak = true;
}
