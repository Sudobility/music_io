/**
 * Tests for the platform-free WAV codec.
 *
 * The round-trip lives here rather than in the platform contract because
 * `decode` on web is `AudioContext.decodeAudioData`, which needs a browser —
 * it cannot run under vitest. This module is the code both implementations
 * genuinely share, so testing it here tests the real thing.
 */
import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav } from "./wav.js";

const SR = 44100;

function tone(hz: number, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1)
    out[i] = Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

describe("wav", () => {
  it("writes a RIFF/WAVE header of the right size", () => {
    const samples = tone(440, 1000);
    const wav = encodeWav({ samples, sampleRate: SR });
    expect(new TextDecoder().decode(new Uint8Array(wav, 0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(new Uint8Array(wav, 8, 4))).toBe("WAVE");
    expect(wav.byteLength).toBe(44 + samples.length * 2);
  });

  it("round-trips samples", () => {
    // Compared by amplitude, not bytes: 16-bit quantisation loses the low bits.
    const samples = tone(440, 1000);
    const decoded = decodeWav(encodeWav({ samples, sampleRate: SR }));
    expect(decoded.sampleRate).toBe(SR);
    expect(decoded.samples.length).toBe(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      expect(Math.abs(decoded.samples[i] - samples[i])).toBeLessThan(0.001);
    }
  });

  it("clips rather than wrapping", () => {
    // A sample over 1.0 must not wrap to a loud click of the opposite sign.
    const decoded = decodeWav(
      encodeWav({ samples: new Float32Array([2, -2]), sampleRate: SR }),
    );
    expect(decoded.samples[0]).toBeGreaterThan(0.99);
    expect(decoded.samples[1]).toBeLessThan(-0.99);
  });
});
