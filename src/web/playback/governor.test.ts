import { describe, expect, it } from 'vitest';
import { Governor } from './governor.js';

describe('Governor', () => {
  it('starts at the best quality, because most machines never need less', () => {
    expect(new Governor().interpolation).toBe(7);
  });

  it('does not step down on a single late frame', () => {
    // One stall is a garbage collection or a resize, not a machine that cannot
    // keep up. Reacting to it would make quality flicker constantly.
    const g = new Governor();
    g.record(0.5);
    expect(g.interpolation).toBe(7);
  });

  it('steps down once lateness persists', () => {
    const g = new Governor();
    for (let i = 0; i < 20; i++) g.record(0.15);
    expect(g.interpolation).toBeLessThan(7);
  });

  it('keeps stepping down while it stays late, but never below zero', () => {
    const g = new Governor();
    for (let i = 0; i < 500; i++) g.record(0.5);
    expect(g.interpolation).toBe(0);
  });

  it('recovers when lateness clears', () => {
    const g = new Governor();
    for (let i = 0; i < 40; i++) g.record(0.2);
    const degraded = g.interpolation;
    expect(degraded).toBeLessThan(7);
    for (let i = 0; i < 400; i++) g.record(0);
    expect(g.interpolation).toBeGreaterThan(degraded);
  });

  it('recovers more slowly than it degrades, so quality cannot oscillate', () => {
    // Falling fast protects the audio; rising fast would just fall again.
    const down = new Governor();
    let framesToDrop = 0;
    while (down.interpolation === 7) {
      down.record(0.2);
      framesToDrop += 1;
    }
    const up = new Governor();
    for (let i = 0; i < framesToDrop; i++) up.record(0.2);
    let framesToRecover = 0;
    while (up.interpolation < 7 && framesToRecover < 10000) {
      up.record(0);
      framesToRecover += 1;
    }
    expect(framesToRecover).toBeGreaterThan(framesToDrop);
  });

  it('reports each change once, so a caller can push it to the synth', () => {
    const seen: number[] = [];
    const g = new Governor({ onChange: (order) => seen.push(order) });
    for (let i = 0; i < 60; i++) g.record(0.3);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length); // no repeats
  });
});
