/**
 * MP3 encoding, shared by every platform.
 *
 * Nothing here touches an audio context: lamejs is pure JavaScript, takes
 * 16-bit PCM and returns MPEG frames. That is what makes it shared rather than
 * per-platform — React Native could always have had mp3 *encoding*, and threw
 * only because the code lived in `web/`.
 */
// @breezystack/lamejs, not lamejs: the original's published build leaves
// MPEGMode undefined outside a browser global scope, so `new Mp3Encoder()`
// throws `ReferenceError: MPEGMode is not defined`. The fork exists to fix
// exactly that — and it is why this works under Metro, where there is no
// browser global scope at all.
import { Mp3Encoder } from "@breezystack/lamejs";
import type { DecodedAudio } from "@sudobility/music_types";

/** One MPEG frame's worth of samples. lamejs expects to be fed in these units. */
const BLOCK = 1152;

/** Constant bitrate, in kbps. 128 is transparent enough for a mono rendering of a score. */
const BITRATE = 128;

function toPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    pcm[i] = Math.max(-1, Math.min(1, samples[i]!)) * 0x7fff;
  }
  return pcm;
}

/** Encodes mono `DecodedAudio` as a constant-bitrate MP3. */
export function encodeMp3({ samples, sampleRate }: DecodedAudio): ArrayBuffer {
  const encoder = new Mp3Encoder(1, sampleRate, BITRATE);
  const pcm = toPcm16(samples);
  const chunks: Uint8Array[] = [];

  for (let i = 0; i < pcm.length; i += BLOCK) {
    const encoded = encoder.encodeBuffer(pcm.subarray(i, i + BLOCK));
    if (encoded.length > 0) chunks.push(new Uint8Array(encoded));
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out.buffer;
}

/**
 * The subset of `AudioBuffer` a mixdown needs — structural, so it accepts the
 * browser's `AudioBuffer` and `react-native-audio-api`'s alike. Neither type is
 * available to this module, and they do not share a declaration.
 */
export type ChannelSource = {
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
};

/**
 * Mixes every channel down to one. The analysis downstream is monophonic, so
 * stereo is work for nothing — and both platforms decode through an
 * `AudioBuffer`-shaped object, so the mixdown is the same code on each.
 */
export function toMono(buffer: ChannelSource): Float32Array {
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 1)
      out[i] += data[i]! / buffer.numberOfChannels;
  }
  return out;
}
