import { describe, expect, it } from 'vitest';
import type { TrackerCell } from '@sudobility/music_types';
import { applyProTrackerEffect } from './protracker-effects.js';

const cell = (): TrackerCell => ({ instrument: 0, note: null });

describe('applyProTrackerEffect', () => {
  it('reads F below 0x20 as ticks per row', () => {
    const c = cell();
    applyProTrackerEffect(c, 0xf, 0x06);
    expect(c.speed).toBe(6);
    expect(c.bpm).toBeUndefined();
  });

  it('reads F at or above 0x20 as beats per minute', () => {
    const c = cell();
    applyProTrackerEffect(c, 0xf, 0x7d);
    expect(c.bpm).toBe(125);
    expect(c.speed).toBeUndefined();
  });

  it('reads D as a pattern break', () => {
    const c = cell();
    applyProTrackerEffect(c, 0xd, 0x00);
    expect(c.patternBreak).toBe(true);
  });

  it('leaves the cell alone for an effect notation import does not use', () => {
    // Portamento, vibrato, arpeggio and the rest have no bearing on notation.
    const c = cell();
    applyProTrackerEffect(c, 0x4, 0x42);
    expect(c).toEqual({ instrument: 0, note: null });
  });

  it('ignores F00, which sets nothing', () => {
    const c = cell();
    applyProTrackerEffect(c, 0xf, 0x00);
    expect(c.speed).toBeUndefined();
    expect(c.bpm).toBeUndefined();
  });
});
