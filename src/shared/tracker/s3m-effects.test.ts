import { describe, expect, it } from 'vitest';
import type { TrackerCell } from '@sudobility/music_types';
import { applyS3mEffect } from './s3m-effects.js';

const cell = (): TrackerCell => ({ instrument: 0, note: null });

describe('applyS3mEffect', () => {
  it('reads command A as ticks per row', () => {
    const c = cell();
    applyS3mEffect(c, 1, 6);
    expect(c.speed).toBe(6);
    expect(c.bpm).toBeUndefined();
  });

  it('reads command T as beats per minute', () => {
    // S3M splits what MOD crams into one effect: A is speed, T is tempo.
    const c = cell();
    applyS3mEffect(c, 20, 125);
    expect(c.bpm).toBe(125);
    expect(c.speed).toBeUndefined();
  });

  it('reads command C as a pattern break', () => {
    const c = cell();
    applyS3mEffect(c, 3, 0);
    expect(c.patternBreak).toBe(true);
  });

  it('ignores a zero parameter, which sets nothing', () => {
    const c = cell();
    applyS3mEffect(c, 1, 0);
    applyS3mEffect(c, 20, 0);
    expect(c.speed).toBeUndefined();
    expect(c.bpm).toBeUndefined();
  });

  it('leaves the cell alone for commands notation import does not use', () => {
    // 2 is B (position jump, deliberately ignored); 4-6 are volume slide and
    // the portamentos, which shape a performance rather than a score.
    const c = cell();
    for (const command of [2, 4, 5, 6, 7, 8, 9, 10]) applyS3mEffect(c, command, 0x42);
    expect(c).toEqual({ instrument: 0, note: null });
  });

  it('does not confuse T with ProTracker numbering', () => {
    // Command 20 is T here. 15 is MOD's F, which is not a tempo command in
    // S3M at all — it is O, sample offset. Asserting *neither* knob moves is
    // what catches a normaliser that borrowed MOD's numbering.
    const c = cell();
    applyS3mEffect(c, 15, 6);
    expect(c.speed).toBeUndefined();
    expect(c.bpm).toBeUndefined();
  });
});
