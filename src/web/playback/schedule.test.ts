import { describe, expect, it } from 'vitest';
import type { Measure, NoteEvent, Score, Track } from '@sudobility/music_types';
import { pitchToMidi } from '../../domain/pitch/pitch.js';
import { twinkleScore, twoTrackScore } from '../../test/fixtures.js';
import { flattenScoreForPlayback, metronomeClicks } from './schedule.js';

const PPQ = 480;
const C_MAJOR = { fifths: 0, mode: 'major' as const };
const FOUR_FOUR = { numerator: 4, denominator: 4 };

/** A single track, single voice, two-measure score with a note tied across the barline. */
function tiedAcrossBarlineScore(): Score {
  const trackId = 'track-1';
  const voiceId = 'voice-1';
  const measureTicks = PPQ * 4; // 4/4 at 480 ppq

  const tieStart: NoteEvent = {
    id: 'note-tie-start',
    pitch: { step: 'C', accidental: 0, octave: 4 },
    startTick: measureTicks - PPQ, // last beat of measure 0
    durationTicks: PPQ,
    velocity: 90,
    voiceId,
    trackId,
    tieStart: true,
  };
  const tieStop: NoteEvent = {
    id: 'note-tie-stop',
    pitch: { step: 'C', accidental: 0, octave: 4 },
    startTick: measureTicks, // first beat of measure 1
    durationTicks: PPQ,
    velocity: 90,
    voiceId,
    trackId,
    tieStop: true,
  };
  const untied: NoteEvent = {
    id: 'note-untied',
    pitch: { step: 'E', accidental: 0, octave: 4 },
    startTick: measureTicks + PPQ,
    durationTicks: PPQ * 3,
    velocity: 90,
    voiceId,
    trackId,
  };

  const measure0: Measure = {
    id: 'm0',
    index: 0,
    startTick: 0,
    durationTicks: measureTicks,
    timeSignature: FOUR_FOUR,
    keySignature: C_MAJOR,
    voices: [{ id: voiceId, name: 'Voice 1', events: [tieStart] }],
  };
  const measure1: Measure = {
    id: 'm1',
    index: 1,
    startTick: measureTicks,
    durationTicks: measureTicks,
    timeSignature: FOUR_FOUR,
    keySignature: C_MAJOR,
    voices: [{ id: voiceId, name: 'Voice 1', events: [tieStop, untied] }],
  };

  const track: Track = {
    id: trackId,
    name: 'Piano',
    instrumentName: 'Piano',
    midiProgram: 0,
    midiChannel: 0,
    clef: 'treble',
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    measures: [measure0, measure1],
  };

  return {
    id: 'score-1',
    version: 1,
    ppq: PPQ,
    metadata: { title: 'Tied', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
    tempoMap: [{ id: 'tempo-0', tick: 0, bpm: 120 }],
    tracks: [track],
  };
}

describe('flattenScoreForPlayback', () => {
  it('produces one scheduled note per note event for an untied melody', () => {
    const score = twinkleScore();
    const scheduled = flattenScoreForPlayback(score);
    // twinkleScore's 8 measures alternate 4 quarter notes / (2 quarters + 1 half) => 4+3 events each, no ties.
    expect(scheduled).toHaveLength(28);
  });

  it('resolves midi pitch, tick, duration, velocity, and provenance correctly', () => {
    const score = twinkleScore();
    const scheduled = flattenScoreForPlayback(score);
    const first = scheduled[0];
    expect(first.tick).toBe(0);
    expect(first.midi).toBe(pitchToMidi({ step: 'C', accidental: 0, octave: 4 }));
    expect(first.velocity).toBe(80);
    expect(first.trackId).toBe(score.tracks[0].id);
    expect(first.noteId).toBe(score.tracks[0].measures[0].voices[0].events[0].id);
  });

  it('joins a note tied across a measure boundary into one sustained note, dropping the continuation note', () => {
    const score = tiedAcrossBarlineScore();
    const scheduled = flattenScoreForPlayback(score);

    const noteIds = scheduled.map((n) => n.noteId);
    expect(noteIds).not.toContain('note-tie-stop');
    expect(noteIds).toContain('note-tie-start');

    const joined = scheduled.find((n) => n.noteId === 'note-tie-start')!;
    expect(joined.tick).toBe(PPQ * 4 - PPQ);
    expect(joined.durTicks).toBe(PPQ * 2); // combined duration of both tied segments

    const untied = scheduled.find((n) => n.noteId === 'note-untied')!;
    expect(untied.tick).toBe(PPQ * 4 + PPQ);
    expect(untied.durTicks).toBe(PPQ * 3);

    expect(scheduled).toHaveLength(2);
  });

  it('flattens every track independently, keeping trackId provenance', () => {
    const score = twoTrackScore();
    const scheduled = flattenScoreForPlayback(score);
    const trackIds = new Set(scheduled.map((n) => n.trackId));
    expect(trackIds).toEqual(new Set(score.tracks.map((t) => t.id)));
  });

  it('is sorted by tick ascending', () => {
    const score = twoTrackScore();
    const scheduled = flattenScoreForPlayback(score);
    for (let i = 1; i < scheduled.length; i += 1) {
      expect(scheduled[i].tick).toBeGreaterThanOrEqual(scheduled[i - 1].tick);
    }
  });

  it('returns an empty array for a score with no tracks', () => {
    const score = twinkleScore();
    expect(flattenScoreForPlayback({ ...score, tracks: [] })).toEqual([]);
  });
});

describe('metronomeClicks', () => {
  it('emits one click per beat, accenting beat 1 of each measure', () => {
    const score = twinkleScore();
    const clicks = metronomeClicks(score);
    // 8 measures of 4/4 => 4 beats each => 32 clicks
    expect(clicks).toHaveLength(32);
    expect(clicks[0]).toEqual({ tick: 0, accent: true });
    expect(clicks[1]).toEqual({ tick: PPQ, accent: false });
    expect(clicks[4]).toEqual({ tick: PPQ * 4, accent: true }); // measure 1, beat 1
  });

  it('returns an empty array for a score with no tracks', () => {
    const score = twinkleScore();
    expect(metronomeClicks({ ...score, tracks: [] })).toEqual([]);
  });
});
