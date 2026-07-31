import { describe, expect, it } from 'vitest';
import type { MidiFile } from '@sudobility/music_types';
import { ToneJsMidiCodec } from './codec.tonejs.js';

function fixture(): MidiFile {
  return {
    header: {
      ppq: 480,
      name: 'T',
      tempos: [{ ticks: 0, bpm: 120 }],
      timeSignatures: [{ ticks: 0, timeSignature: [4, 4] }],
    },
    tracks: [
      {
        name: 'Piano',
        channel: 0,
        instrument: { number: 0 },
        notes: [{ midi: 60, ticks: 0, durationTicks: 480, velocity: 0.8 }],
        controlChanges: {
          7: [{ number: 7, ticks: 0, value: 1 }],
          10: [{ number: 10, ticks: 0, value: 0.5 }],
        },
        durationTicks: 480,
        durationSeconds: 0.5,
      },
    ],
    duration: 0.5,
  };
}

describe('ToneJsMidiCodec', () => {
  it('round-trips a file through encode and decode', () => {
    const codec = new ToneJsMidiCodec();
    const decoded = codec.decode(codec.encode(fixture()).buffer as ArrayBuffer);

    expect(decoded.header.ppq).toBe(480);
    expect(decoded.header.tempos[0].bpm).toBeCloseTo(120, 1);
    expect(decoded.header.timeSignatures[0].timeSignature).toEqual([4, 4]);
    expect(decoded.tracks[0].notes[0].midi).toBe(60);
    expect(decoded.tracks[0].notes[0].durationTicks).toBe(480);
  });

  it('preserves control changes keyed by CC number', () => {
    // The importer looks up sustain (64), volume (7) and pan (10) directly by
    // number. A flat list here would lose volume and pan silently rather than
    // loudly, which is why the model keys them.
    const codec = new ToneJsMidiCodec();
    const decoded = codec.decode(codec.encode(fixture()).buffer as ArrayBuffer);

    expect(decoded.tracks[0].controlChanges[7]?.[0].value).toBeCloseTo(1, 2);
    expect(decoded.tracks[0].controlChanges[10]?.[0].value).toBeCloseTo(0.5, 2);
  });

  it('reports per-track duration, which the import wizard lists', () => {
    const codec = new ToneJsMidiCodec();
    const decoded = codec.decode(codec.encode(fixture()).buffer as ArrayBuffer);

    expect(decoded.tracks[0].durationTicks).toBe(480);
    expect(decoded.tracks[0].durationSeconds).toBeGreaterThan(0);
    expect(decoded.duration).toBeGreaterThan(0);
  });
});
