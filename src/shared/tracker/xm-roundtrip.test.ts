/**
 * Score -> module -> bytes -> module -> score.
 *
 * The spec's strongest automated check, and it costs nothing because both
 * halves already exist. Round-tripping the *module* (see `xm-write.test.ts`)
 * proves the byte layout; this proves the musical conversion either side of it,
 * which is where a grid or channel mistake would hide.
 */
import { describe, expect, it } from 'vitest';
import { scoreToTracker, trackerToScore, threeTrackScore, pitchToMidi } from '@sudobility/music_lib';
import type { Score } from '@sudobility/music_types';
import { encodeXm } from './xm-write.js';
import { readXm } from './xm.js';

function midiNotes(score: Score): number[] {
  const out: number[] = [];
  for (const track of score.tracks) {
    for (const measure of track.measures) {
      for (const voice of measure.voices) {
        for (const event of voice.events) {
          if ('pitch' in event) out.push(pitchToMidi(event.pitch));
        }
      }
    }
  }
  return out.sort((a, b) => a - b);
}

describe('XM export round trip', () => {
  const original = threeTrackScore();
  const { module, report } = scoreToTracker(original, { format: 'xm' });
  const returned = trackerToScore(readXm(encodeXm(module)));

  it('loses nothing on the way out', () => {
    // If this fails the rest of the comparison is meaningless — a lossy export
    // is allowed, but this fixture is meant to fit XM exactly.
    expect(report).toEqual({
      clampedNotes: 0,
      droppedVoices: 0,
      droppedShortNotes: 0,
      quantisedNotes: 0,
    });
  });

  it('brings back every note at its original pitch', () => {
    expect(midiNotes(returned)).toEqual(midiNotes(original));
  });

  it('brings back one track per instrument', () => {
    expect(returned.tracks).toHaveLength(original.tracks.length);
  });

  it('keeps the instrument names, which is what the empty slots carry', () => {
    expect(returned.tracks.map((t) => t.name).sort()).toEqual(
      original.tracks.map((t) => t.instrumentName).sort(),
    );
  });

  it('keeps the tempo, which lives in cells rather than the header', () => {
    // trackerToScore reads speed/bpm only from cells; a header-only tempo would
    // come back as the 125 BPM default.
    expect(returned.tempoMap[0].bpm).toBe(original.tempoMap[0].bpm);
  });
});
