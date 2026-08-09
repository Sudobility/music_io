/**
 * Instrument factories (spec §10, Task 13 brief): one synthesized voice per
 * General MIDI family, chosen by `createInstrument(nameOrProgram, isPercussion)`
 * from a track's `midiProgram` (preferred) or `instrumentName`.
 * `tone-engine.ts` and the offline renderer are the only intended callers —
 * both do their own scheduling and just need a uniform handle per track.
 *
 * The work is split four ways, because these change for different reasons:
 *
 * - `categories.ts` — *which* voice a track gets, as a statement about GM
 * - `voices.ts` — what each voice sounds like, as one comparable table
 * - `calibration.ts` — how loud each one is, from measurement
 * - `drum-kit.ts` — the one family that is ten instruments, not one
 *
 * with `handle.ts` holding the contract they all meet and `velocity.ts` the
 * two ways a voice can answer how hard it was played.
 */
import { buildVoice } from './voices.js';
import { resolveInstrumentCategory } from './categories.js';
import { OUTPUT_TRIM_DB, withOutputTrim } from './calibration.js';
import type { InstrumentHandle } from './handle.js';

export type { InstrumentHandle } from './handle.js';
export type { InstrumentCategory } from './categories.js';
export { resolveInstrumentCategory, voiceSourceFor } from './categories.js';

/**
 * Builds the voice for a track. `isPercussion` (a `percussion`-clef track per
 * spec §4) always yields the drum kit, whatever the program or name says.
 */
export function createInstrument(nameOrProgram: string | number, isPercussion: boolean): InstrumentHandle {
  const category = resolveInstrumentCategory(nameOrProgram, isPercussion);
  return withOutputTrim(buildVoice(category), OUTPUT_TRIM_DB[category]);
}
