/**
 * React Native audio codec.
 *
 * WAV works: the header writer is platform-free, so encoding and decoding
 * `.wav` need nothing native. **MP3 does not** — React Native has no
 * `decodeAudioData` and no bundled encoder, so those two throw rather than
 * returning silence or noise that would look like a transcription bug.
 *
 * When RN needs mp3, it wants a native module here; the interface already has
 * the right shape for one.
 */
import type { AudioCodec, DecodedAudio } from '@sudobility/music_types';
import { decodeWav, encodeWav } from '../shared/audio/wav.js';

/** 'RIFF' — the first four bytes of every WAV file. */
function isWav(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false;
  const head = new Uint8Array(bytes, 0, 4);
  return head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46;
}

export function createRNAudioCodec(): AudioCodec {
  return {
    decode(bytes: ArrayBuffer): Promise<DecodedAudio> {
      if (!isWav(bytes)) {
        return Promise.reject(
          new Error('Only .wav can be decoded on React Native; .mp3/.mpa need a native decoder'),
        );
      }
      return Promise.resolve(decodeWav(bytes));
    },
    encodeWav,
    encodeMp3(): ArrayBuffer {
      throw new Error('MP3 encoding is not available on React Native');
    },
  };
}
