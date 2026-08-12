import { describe, expect, it } from 'vitest';
import { NoteQueue } from './note-queue.js';
import type { ScheduledNote } from './schedule.js';

const note = (tick: number, id: string): ScheduledNote => ({
  tick,
  durTicks: 480,
  midi: 60,
  velocity: 90,
  trackId: 't1',
  noteId: id,
});

describe('NoteQueue', () => {
  it('returns only notes starting at or before the drain point, once each', () => {
    // The cursor is the point: draining twice must not sound a note twice.
    const q = new NoteQueue();
    q.load([note(0, 'a'), note(480, 'b'), note(960, 'c')]);
    expect(q.drainUntil(480).map((n) => n.noteId)).toEqual(['a', 'b']);
    expect(q.drainUntil(480).map((n) => n.noteId)).toEqual([]);
    expect(q.drainUntil(960).map((n) => n.noteId)).toEqual(['c']);
  });

  it('sorts on load, so callers need not', () => {
    const q = new NoteQueue();
    q.load([note(960, 'c'), note(0, 'a')]);
    expect(q.drainUntil(9999).map((n) => n.noteId)).toEqual(['a', 'c']);
  });

  it('seeking moves the cursor without rescheduling anything', () => {
    // What this buys: seeking a 200-second piece used to mean cancelling and
    // rebuilding some 11,500 scheduled events.
    const q = new NoteQueue();
    q.load([note(0, 'a'), note(480, 'b'), note(960, 'c')]);
    q.seekToTick(480);
    expect(q.drainUntil(9999).map((n) => n.noteId)).toEqual(['b', 'c']);
  });

  it('seeking backwards replays the notes it moved behind', () => {
    const q = new NoteQueue();
    q.load([note(0, 'a'), note(480, 'b')]);
    q.drainUntil(9999);
    q.seekToTick(0);
    expect(q.drainUntil(9999).map((n) => n.noteId)).toEqual(['a', 'b']);
  });

  it('reports exhaustion so the caller can stop at the end', () => {
    const q = new NoteQueue();
    q.load([note(0, 'a')]);
    expect(q.exhausted).toBe(false);
    q.drainUntil(9999);
    expect(q.exhausted).toBe(true);
  });

  it('is empty, not broken, before anything is loaded', () => {
    const q = new NoteQueue();
    expect(q.drainUntil(9999)).toEqual([]);
    expect(q.exhausted).toBe(true);
  });
});
