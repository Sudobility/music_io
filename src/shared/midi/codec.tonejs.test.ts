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

function vlq(value: number): number[] {
  const bytes = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function ascii(value: string): number[] {
  return [...value].map((char) => char.charCodeAt(0));
}

function midiEvent(deltaTicks: number, bytes: number[]): number[] {
  return [...vlq(deltaTicks), ...bytes];
}

function formatZeroInterleavedChannelSetup(): ArrayBuffer {
  const track = [
    ...midiEvent(0, [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]),
    ...midiEvent(0, [0xb0, 7, 100]),
    ...midiEvent(0, [0xb0, 10, 32]),
    ...midiEvent(0, [0xc0, 33]),
    ...midiEvent(0, [0xb1, 7, 60]),
    ...midiEvent(0, [0xb1, 10, 96]),
    ...midiEvent(0, [0xc1, 36]),
    ...midiEvent(240, [0x90, 40, 100]),
    ...midiEvent(0, [0x91, 52, 80]),
    ...midiEvent(120, [0x80, 40, 0]),
    ...midiEvent(0, [0x81, 52, 0]),
    ...midiEvent(0, [0xff, 0x2f, 0x00]),
  ];

  const bytes = new Uint8Array([
    ...ascii('MThd'),
    ...u32(6),
    ...u16(0),
    ...u16(1),
    ...u16(480),
    ...ascii('MTrk'),
    ...u32(track.length),
    ...track,
  ]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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

  it('keeps format-0 tick-0 channel volume and pan with their following note tracks', () => {
    const codec = new ToneJsMidiCodec();
    const decoded = codec.decode(formatZeroInterleavedChannelSetup());
    const noteTracks = decoded.tracks.filter((track) => track.notes.length > 0);

    expect(noteTracks).toHaveLength(2);
    expect(noteTracks[0].channel).toBe(0);
    expect(noteTracks[0].instrument.number).toBe(33);
    expect(noteTracks[0].controlChanges[7]?.[0].value).toBeCloseTo(100 / 127, 4);
    expect(noteTracks[0].controlChanges[10]?.[0].value).toBeCloseTo(32 / 127, 4);

    expect(noteTracks[1].channel).toBe(1);
    expect(noteTracks[1].instrument.number).toBe(36);
    expect(noteTracks[1].controlChanges[7]?.[0].value).toBeCloseTo(60 / 127, 4);
    expect(noteTracks[1].controlChanges[10]?.[0].value).toBeCloseTo(96 / 127, 4);
  });
});
