import { describe, expect, it, vi } from "vitest";
import { createRNAudioCodec } from "./audio-codec.js";

/**
 * A stand-in for `react-native-audio-api`'s native decoder. The real one hands
 * bytes to AVFoundation / MediaCodec, which no test here can run — so what is
 * checked is everything on our side of it: that the decoder is reached, that
 * the buffer is not detached out from under the caller, and that the
 * multi-channel result is mixed down rather than truncated.
 */
function fakeDecoder(channels: number[][], sampleRate = 44100) {
  return vi.fn(async (_input: ArrayBuffer) => ({
    length: channels[0]!.length,
    numberOfChannels: channels.length,
    sampleRate,
    getChannelData: (c: number) => Float32Array.from(channels[c]!),
  }));
}

describe("RN audio codec", () => {
  it("decodes through the native decoder and mixes down to mono", async () => {
    const decode = fakeDecoder([
      [1, 1, 1],
      [-1, 0, 1],
    ]);
    const codec = createRNAudioCodec({ loadDecoder: async () => decode });

    const audio = await codec.decode(new ArrayBuffer(8));

    expect(decode).toHaveBeenCalledOnce();
    expect(Array.from(audio.samples)).toEqual([0, 0.5, 1]);
    expect(audio.sampleRate).toBe(44100);
  });

  it("does not hand the caller's buffer to the decoder, which may detach it", async () => {
    const decode = fakeDecoder([[0, 0]]);
    const codec = createRNAudioCodec({ loadDecoder: async () => decode });
    const bytes = new ArrayBuffer(16);

    await codec.decode(bytes);

    expect(decode.mock.calls[0]![0]).not.toBe(bytes);
    expect(bytes.byteLength).toBe(16); // still the caller's, still intact
  });

  it("decodes mp3, not only wav — the capability this platform used to refuse", async () => {
    // The old codec sniffed for a 'RIFF' header and rejected anything else.
    // Nothing here inspects the bytes; the OS decoder decides what it can read.
    const decode = fakeDecoder([[0.5, 0.5]]);
    const codec = createRNAudioCodec({ loadDecoder: async () => decode });
    const mp3ish = new Uint8Array([0xff, 0xfb, 0x90, 0x00]).buffer;

    await expect(codec.decode(mp3ish)).resolves.toMatchObject({
      sampleRate: 44100,
    });
  });

  it("reports a version problem as a version problem when the native module is too old", async () => {
    const codec = createRNAudioCodec({
      loadDecoder: async () => {
        throw new Error(
          "react-native-audio-api does not export decodeAudioData; audio import needs >=0.13.",
        );
      },
    });

    await expect(codec.decode(new ArrayBuffer(4))).rejects.toThrow(">=0.13");
  });

  it("encodes mp3 rather than throwing — lamejs is pure JS and never needed a browser", () => {
    const codec = createRNAudioCodec();
    const samples = new Float32Array(44100 / 2);
    for (let i = 0; i < samples.length; i += 1)
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);

    const bytes = new Uint8Array(
      codec.encodeMp3({ samples, sampleRate: 44100 }),
    );

    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]! & 0xe0).toBe(0xe0);
  });

  it("encodes wav", () => {
    const wav = createRNAudioCodec().encodeWav({
      samples: new Float32Array(100),
      sampleRate: 44100,
    });
    expect(new TextDecoder().decode(new Uint8Array(wav, 0, 4))).toBe("RIFF");
  });
});
