/**
 * Holding a note for longer than the recording lasts.
 *
 * Every FluidR3 sample pack entry is **3.13 seconds**, whatever the instrument.
 * That is not a limit of the format, just how they were rendered — but it means
 * a note written longer than that simply stops sounding partway through. A whole
 * note at 60bpm is four seconds. A tied pad across a phrase is many. Those went
 * silent, with the gain envelope still dutifully holding a level over nothing.
 *
 * SF2 solves this with loop points, and the packs lost them along with
 * everything else in the `sdta` chunk. What survives is the audio, and for an
 * instrument that *holds* its level — measured per instrument by
 * `scripts/measure-expression.mjs` — a window inside its steady portion can be
 * looped to sustain it indefinitely.
 *
 * Only for those instruments. Looping a piano's tail would hold a note that is
 * supposed to die away, which is a worse and more obvious error than the
 * truncation it fixes.
 */
import type { RNAudioBuffer, RNBufferSource } from './audio-api.js';

/** Kept clear of the end, which holds the rendered note's own release. */
const TAIL_GUARD_SECONDS = 0.35;
/**
 * Longest loop window worth taking.
 *
 * Long enough that any period mismatch at the seam recurs rarely, short enough
 * to sit inside the steady portion of a 3.13s recording.
 */
const MAX_LOOP_SECONDS = 1.0;
/** Shorter than this and the seam recurs often enough to be heard as a pitch. */
const MIN_LOOP_SECONDS = 0.25;

/**
 * Points a source at a loop inside its own sustain, if it needs one and one fits.
 *
 * Returns whether looping was applied — false when the note is short enough to
 * play straight through, or the recording too short to find a window in.
 *
 * Loop bounds are nudged onto rising zero crossings. It does not make the seam
 * seamless (that would need pitch-aware placement, or a crossfade this API
 * cannot express on one node), but matching sign and slope removes the step
 * discontinuity that is the audible part of a bad loop.
 */
export function applySustainLoop(
  source: RNBufferSource,
  buffer: RNAudioBuffer,
  neededSeconds: number,
): boolean {
  const duration = buffer.duration;
  if (neededSeconds <= duration) return false;

  const end = duration - TAIL_GUARD_SECONDS;
  const window = Math.min(MAX_LOOP_SECONDS, end / 2);
  if (end <= 0 || window < MIN_LOOP_SECONDS) return false;

  const channel = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const loopEnd = nearestRisingZero(channel, Math.floor(end * rate), rate) / rate;
  const loopStart = nearestRisingZero(channel, Math.floor((end - window) * rate), rate) / rate;
  if (!(loopEnd > loopStart)) return false;

  source.loop = true;
  source.loopStart = loopStart;
  source.loopEnd = loopEnd;
  return true;
}

/**
 * The nearest sample index where the waveform crosses zero going upward.
 *
 * Searched within a few milliseconds either way — far enough to find a crossing
 * at any musical pitch, near enough not to move the loop bound audibly.
 */
function nearestRisingZero(channel: Float32Array, at: number, sampleRate: number): number {
  const reach = Math.floor(0.005 * sampleRate);
  const lo = Math.max(1, at - reach);
  const hi = Math.min(channel.length - 1, at + reach);
  for (let offset = 0; offset <= reach; offset += 1) {
    for (const index of [at - offset, at + offset]) {
      if (index <= lo || index >= hi) continue;
      if (channel[index - 1]! <= 0 && channel[index]! > 0) return index;
    }
  }
  return at;
}
