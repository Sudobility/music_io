/**
 * Web audio decoding and encoding.
 *
 * Decoding leans on `AudioContext.decodeAudioData`, which already understands
 * wav and mp3 — and therefore `.mpa`, which is the same MPEG audio — so nothing
 * has to bundle a decoder. Encoding mp3 does need one; wav does not.
 */
import { Mp3Encoder } from 'lamejs';
import type { AudioCodec, DecodedAudio } from '@sudobility/music_types';
import { encodeWav } from '../../shared/audio/wav.js';

/** Mixes to mono: the analysis is monophonic, so stereo is work for nothing. */
function toMono(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 1) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

function toPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 0x7fff;
  }
  return pcm;
}

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

    encodeMp3({ samples, sampleRate }: DecodedAudio): ArrayBuffer {
      const encoder = new Mp3Encoder(1, sampleRate, 128);
      const pcm = toPcm16(samples);
      const chunks: Uint8Array[] = [];
      const BLOCK = 1152; // one MPEG frame

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
    },
  };
}
