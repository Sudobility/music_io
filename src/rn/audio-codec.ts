/**
 * React Native audio codec — complete, and the same capabilities as web.
 *
 * Decoding goes through `react-native-audio-api`'s native `decodeAudioData`,
 * which hands the bytes to the platform decoder (AVFoundation on iOS,
 * MediaCodec on Android) and so understands wav, mp3 and `.mpa` — the same
 * formats `AudioContext.decodeAudioData` gives the web, for the same reason:
 * neither platform bundles a decoder, both borrow the OS's.
 *
 * Encoding is `shared/audio/`: wav is a header writer and mp3 is lamejs, both
 * pure JavaScript, so neither was ever platform-bound.
 *
 * This used to accept wav only and throw for everything else — not because
 * React Native could not do it, but because the code lived in `web/`.
 *
 * The import is lazy so that merely loading this module without
 * `react-native-audio-api` present (this package's own test run, a Node script)
 * does not throw. Only `decode()` needs it. Same pattern as `file.rn.ts`.
 */
import type { AudioCodec, DecodedAudio } from "@sudobility/music_types";
import { encodeWav } from "../shared/audio/wav.js";
import { encodeMp3, toMono } from "../shared/audio/mp3.js";
import type { ChannelSource } from "../shared/audio/mp3.js";

type DecodeAudioData = (
  input: ArrayBuffer,
  sampleRate?: number,
) => Promise<ChannelSource>;

/** Overridable for tests, which have no native module to load. */
export type RNAudioCodecOptions = {
  loadDecoder?: () => Promise<DecodeAudioData>;
};

async function defaultLoadDecoder(): Promise<DecodeAudioData> {
  const mod = (await import("react-native-audio-api")) as unknown as {
    decodeAudioData?: DecodeAudioData;
    default?: { decodeAudioData?: DecodeAudioData };
  };
  const decode = mod.decodeAudioData ?? mod.default?.decodeAudioData;
  if (!decode) {
    throw new Error(
      "react-native-audio-api does not export decodeAudioData; audio import needs >=0.13.",
    );
  }
  return decode;
}

export function createRNAudioCodec(
  options: RNAudioCodecOptions = {},
): AudioCodec {
  const loadDecoder = options.loadDecoder ?? defaultLoadDecoder;

  return {
    async decode(bytes: ArrayBuffer): Promise<DecodedAudio> {
      const decodeAudioData = await loadDecoder();
      // `slice(0)` mirrors the web codec: a decoder is entitled to detach the
      // buffer it is handed, which would leave the caller holding an empty one.
      const buffer = await decodeAudioData(bytes.slice(0));
      return { samples: toMono(buffer), sampleRate: buffer.sampleRate };
    },

    encodeWav,
    encodeMp3,
  };
}
