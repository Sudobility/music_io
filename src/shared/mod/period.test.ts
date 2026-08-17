import { describe, expect, it } from 'vitest';
import { periodToMidi } from './period.js';

describe('periodToMidi', () => {
  it('maps ProTracker C-1 to MIDI 36', () => {
    expect(periodToMidi(856)).toBe(36);
  });

  it('maps an octave up to twelve semitones up', () => {
    expect(periodToMidi(428)).toBe(48);
  });

  it('treats a zero or negative period as no note', () => {
    expect(periodToMidi(0)).toBeNull();
    expect(periodToMidi(-1)).toBeNull();
  });
});
