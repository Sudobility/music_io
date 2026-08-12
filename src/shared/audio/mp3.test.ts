/**
 * `encodeMp3` needs only `lamejs`, not an audio context — so unlike
 * `renderOffline` it can be tested here, and should be: it is otherwise the
 * least-verified path in the audio work. Living in `shared/` is the whole
 * point: this is the same code both platforms run, so one test covers both.
 */
import { describe, expect, it } from 'vitest';
import { encodeMp3, toMono } from './mp3.js';

describe('encodeMp3', () => {
  it('produces a real MPEG frame', () => {
    const sampleRate = 44100;
    const samples = new Float32Array(sampleRate / 2);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    }

    const bytes = new Uint8Array(encodeMp3({ samples, sampleRate }));
    expect(bytes.length).toBeGreaterThan(0);
    // Eleven set bits start every MPEG audio frame: 0xFF then 0xE0-0xFF.
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1] & 0xe0).toBe(0xe0);
  });

  it('runs with no audio context, no DOM and no browser global scope — which is what makes it shared', () => {
    // The reason React Native can have mp3 encoding at all. If this ever needs
    // a context, it belongs back in `web/` and RN loses the capability.
    expect(typeof globalThis.AudioContext).toBe('undefined');
    expect(encodeMp3({ samples: new Float32Array(4096), sampleRate: 44100 }).byteLength).toBeGreaterThan(0);
  });
});

describe('toMono', () => {
  it('averages every channel rather than taking the first', () => {
    const left = Float32Array.from([1, 1, 1]);
    const right = Float32Array.from([-1, 0, 1]);
    const buffer = {
      length: 3,
      numberOfChannels: 2,
      sampleRate: 44100,
      getChannelData: (c: number) => (c === 0 ? left : right),
    };

    expect(Array.from(toMono(buffer))).toEqual([0, 0.5, 1]);
  });
});
