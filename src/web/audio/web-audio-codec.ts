/**
 * Web audio decoding.
 *
 * Decoding leans on `AudioContext.decodeAudioData`, which already understands
 * wav and mp3 — and therefore `.mpa`, which is the same MPEG audio — so nothing
 * has to bundle a decoder. React Native reaches its own OS decoder the same
 * way; see `rn/audio-codec.ts`.
 *
 * Both encoders live in `shared/audio/`, because neither ever needed a browser:
 * wav is a header writer and mp3 is lamejs, both pure JavaScript.
 */
import type { AudioCodec, DecodedAudio } from '@sudobility/music_types';
import { encodeWav } from '../../shared/audio/wav.js';
import { encodeMp3, toMono } from '../../shared/audio/mp3.js';

export function createWebAudioCodec(): AudioCodec {
  return {
    async decode(bytes: ArrayBuffer): Promise<DecodedAudio> {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor();
      try {
        // `slice(0)`: decodeAudioData detaches the buffer it is given, which
        // would leave the caller holding an empty ArrayBuffer.
        const buffer = await ctx.decodeAudioData(bytes.slice(0));
        return { samples: toMono(buffer), sampleRate: buffer.sampleRate };
      } finally {
        void ctx.close();
      }
    },

    encodeWav,
    encodeMp3,
  };
}
