/**
 * The master-bus rules, shared by live playback (`tone-engine.ts`) and offline
 * export (`../audio/render.ts`).
 *
 * They live here rather than in either caller because an export that mixed
 * differently from playback is exactly the bug this module exists to prevent:
 * the file is supposed to be a recording of what was heard, and two copies of
 * these numbers would drift apart the first time one was tuned.
 */

/**
 * Ceiling for the safety limiter on the master bus, in dB below full scale.
 *
 * The headroom trim sizes the mix for how loud it is *on average*; this catches
 * the peaks it cannot predict — the moments when parts happen to line up in
 * phase, which sum far above the incoherent average. Just under full scale
 * rather than at it, so the limiter, and not the sound card, decides the
 * ceiling.
 */
export const LIMITER_CEILING_DB = -1;

/**
 * How far to pull the master down for `trackCount` channels summing into it.
 *
 * Every channel is scheduled at its own MIDI volume with nothing reconciling
 * them, so the mix got louder with every track added. A nine-track arrangement
 * summed to roughly two and a half times full scale and clipped through most of
 * the piece; what that distortion buried first were the quiet, sustained
 * voices, which is why tracks that were neither muted nor silent could not be
 * heard at all.
 *
 * `1/sqrt(n)`, not `1/n`: separate instrument parts are not phase-correlated,
 * so their powers add rather than their amplitudes. `1/n` is the law for copies
 * of one signal and would leave a large arrangement far too quiet. A single
 * track keeps unity — it has nothing to sum with.
 */
export function headroomTrimFor(trackCount: number): number {
  return trackCount > 1 ? 1 / Math.sqrt(trackCount) : 1;
}
