/**
 * `encodeMp3` needs only `lamejs`, not an audio context — so unlike
 * `renderOffline` it can be tested here, and should be: it is otherwise the
 * least-verified path in the audio work.
 */
import { describe, expect, it } from 'vitest';
import { createWebAudioCodec } from './web-audio-codec.js';

describe('encodeMp3', () => {
  it('produces a real MPEG frame', () => {
    const sampleRate = 44100;
    const samples = new Float32Array(sampleRate / 2);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    }

    const bytes = new Uint8Array(createWebAudioCodec().encodeMp3({ samples, sampleRate }));
    expect(bytes.length).toBeGreaterThan(0);
    // Eleven set bits start every MPEG audio frame: 0xFF then 0xE0-0xFF.
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1] & 0xe0).toBe(0xe0);
  });
});
