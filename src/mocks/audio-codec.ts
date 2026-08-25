/**
 * A mock audio codec.
 *
 * Its WAV encoding is the *real* one — the header writer is platform-free — so
 * the contract test exercises the same bytes the web build produces. Only
 * decoding is stubbed, because there is no Web Audio here: it understands the
 * WAV this codec writes, and nothing else.
 */
import type { AudioCodec, DecodedAudio } from "@sudobility/music_types";
import { decodeWav, encodeWav } from "../shared/audio/wav.js";

export function createMockAudioCodec(): AudioCodec {
  return {
    decode: (bytes: ArrayBuffer): Promise<DecodedAudio> =>
      Promise.resolve(decodeWav(bytes)),
    encodeWav,
    // Not a real mp3 — enough to prove the capability is wired and returns
    // bytes. Verifying mp3 output would need a decoder in the test environment.
    encodeMp3: (audio: DecodedAudio): ArrayBuffer => encodeWav(audio),
  };
}
