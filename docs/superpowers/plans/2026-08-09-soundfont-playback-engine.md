# Soundfont Playback Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Tone.js synthesis engine in `music_io` with libfluidsynth-WASM running in an AudioWorklet, fed by a note queue, so playback stays correct on ordinary hardware.

**Architecture:** A note queue with a cursor lives on the main thread. A pump drains a lookahead window every 50ms and posts sample-stamped MIDI events to an AudioWorklet hosting libfluidsynth, which renders on the audio thread. Voice allocation and stealing are the synth's. `PlaybackEngine` in `music_types` is unchanged, so `music_lib` and `music_app` are untouched.

**Tech Stack:** TypeScript, `js-synthesizer` 1.13 (BSD-3), `libfluidsynth-2.4.6-with-libsndfile` (LGPL-2.1), Web Audio `AudioWorklet`, vitest.

## Global Constraints

- Package is `@sudobility/music_io`, ESM only, built with `tsc -p tsconfig.build.json`.
- Tests are vitest. Run with `bun run test`. Typecheck `bun run typecheck`. Lint `bun run lint` (max-warnings 0).
- The SF3 build is required: `libfluidsynth-2.4.6-with-libsndfile.js`, not the plain build. SF3 will not load without it.
- **Never call `midiProgramSelect` on a percussion channel.** FluidSynth's GM mode maps channel 9 to percussion by default; an explicit bank-128 select silences it. Verified in `spikes/js-synthesizer-in-audioworklet.md`.
- Polyphony has no setter on the worklet API and needs none — fluidsynth steals voices at its default.
- Master chain keeps the existing arithmetic: `1/sqrt(n)` headroom trim (`headroomTrimFor`) and a −1 dBFS limiter (`LIMITER_CEILING_DB`), both currently in `src/web/playback/mix.ts`. Keep that file.
- `flattenScoreForPlayback` and `metronomeClicks` in `src/web/playback/schedule.ts` are correct and stay as-is.
- Every task ends green: typecheck, lint, and the full suite.

---

### Task 1: NoteQueue

Pure logic, no audio. The cursor is what makes seeking cheap.

**Files:**
- Create: `src/web/playback/note-queue.ts`
- Test: `src/web/playback/note-queue.test.ts`

**Interfaces:**
- Consumes: `ScheduledNote` from `./schedule.js` (`{ tick, durTicks, midi, velocity, trackId, noteId }`).
- Produces: `class NoteQueue` with `load(notes: readonly ScheduledNote[]): void`, `seekToTick(tick: number): void`, `drainUntil(tick: number): ScheduledNote[]`, `get exhausted(): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { NoteQueue } from './note-queue.js';
import type { ScheduledNote } from './schedule.js';

const note = (tick: number, id: string): ScheduledNote => ({
  tick, durTicks: 480, midi: 60, velocity: 90, trackId: 't1', noteId: id,
});

describe('NoteQueue', () => {
  it('returns only notes starting at or before the drain point, once each', () => {
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
    const q = new NoteQueue();
    q.load([note(0, 'a'), note(480, 'b'), note(960, 'c')]);
    q.seekToTick(480);
    expect(q.drainUntil(9999).map((n) => n.noteId)).toEqual(['b', 'c']);
  });

  it('reports exhaustion so the caller can stop at the end', () => {
    const q = new NoteQueue();
    q.load([note(0, 'a')]);
    expect(q.exhausted).toBe(false);
    q.drainUntil(9999);
    expect(q.exhausted).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd ~/projects/music_io && bunx vitest run src/web/playback/note-queue.test.ts`
Expected: FAIL — cannot resolve `./note-queue.js`.

- [ ] **Step 3: Implement**

```ts
/**
 * The notes of a score, in time order, with a cursor.
 *
 * Replaces scheduling every note up front. Seeking is a cursor move rather
 * than cancelling and rebuilding thousands of scheduled events, which is what
 * makes seek and edit cheap however long the piece is.
 */
import type { ScheduledNote } from './schedule.js';

export class NoteQueue {
  private notes: ScheduledNote[] = [];
  private cursor = 0;

  load(notes: readonly ScheduledNote[]): void {
    this.notes = [...notes].sort((a, b) => a.tick - b.tick);
    this.cursor = 0;
  }

  /** Binary search to the first note at or after `tick`. */
  seekToTick(tick: number): void {
    let lo = 0;
    let hi = this.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid].tick < tick) lo = mid + 1;
      else hi = mid;
    }
    this.cursor = lo;
  }

  /** Every not-yet-returned note starting at or before `tick`, advancing the cursor past them. */
  drainUntil(tick: number): ScheduledNote[] {
    const out: ScheduledNote[] = [];
    while (this.cursor < this.notes.length && this.notes[this.cursor].tick <= tick) {
      out.push(this.notes[this.cursor]);
      this.cursor += 1;
    }
    return out;
  }

  get exhausted(): boolean {
    return this.cursor >= this.notes.length;
  }
}
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `bunx vitest run src/web/playback/note-queue.test.ts` — expect 4 passed.
Then `bun run typecheck && bun run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/web/playback/note-queue.ts src/web/playback/note-queue.test.ts
git commit -m "feat(playback): note queue with a cursor"
```

---

### Task 2: ChannelAllocator

**Files:**
- Create: `src/web/playback/channel-allocator.ts`
- Test: `src/web/playback/channel-allocator.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type ChannelAssignment = { instance: number; channel: number; isPercussion: boolean }`, `type AllocatorTrack = { id: string; isPercussion: boolean }`, and `function allocateChannels(tracks: readonly AllocatorTrack[]): { assignments: Map<string, ChannelAssignment>; instanceCount: number }`.

Percussion tracks take channel 9 where free, then any other channel switched to drum type via `midiSetChannelType` (see spike). Pitched tracks never take channel 9.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { allocateChannels } from './channel-allocator.js';

const pitched = (id: string) => ({ id, isPercussion: false });
const drums = (id: string) => ({ id, isPercussion: true });

describe('allocateChannels', () => {
  it('puts a drum track on channel 9, which GM maps to percussion by default', () => {
    const { assignments, instanceCount } = allocateChannels([drums('d')]);
    expect(assignments.get('d')).toEqual({ instance: 0, channel: 9, isPercussion: true });
    expect(instanceCount).toBe(1);
  });

  it('never gives channel 9 to a pitched track', () => {
    const { assignments } = allocateChannels(Array.from({ length: 15 }, (_, i) => pitched(`p${i}`)));
    for (const a of assignments.values()) expect(a.channel).not.toBe(9);
  });

  it('fits 15 pitched tracks in one instance and opens a second for the 16th', () => {
    const tracks = Array.from({ length: 16 }, (_, i) => pitched(`p${i}`));
    const { assignments, instanceCount } = allocateChannels(tracks);
    expect(instanceCount).toBe(2);
    expect(assignments.get('p15')?.instance).toBe(1);
  });

  it('gives a second drum track an ordinary channel marked as percussion', () => {
    const { assignments } = allocateChannels([drums('d1'), drums('d2')]);
    expect(assignments.get('d1')).toEqual({ instance: 0, channel: 9, isPercussion: true });
    const second = assignments.get('d2');
    expect(second?.isPercussion).toBe(true);
    expect(second?.channel).not.toBe(9);
  });

  it('assigns every track exactly once', () => {
    const tracks = [drums('d'), ...Array.from({ length: 40 }, (_, i) => pitched(`p${i}`))];
    const { assignments } = allocateChannels(tracks);
    expect(assignments.size).toBe(41);
    const seen = new Set([...assignments.values()].map((a) => `${a.instance}:${a.channel}`));
    expect(seen.size).toBe(41);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bunx vitest run src/web/playback/channel-allocator.test.ts`
Expected: FAIL — cannot resolve `./channel-allocator.js`.

- [ ] **Step 3: Implement**

```ts
/**
 * Which synth instance and MIDI channel each track plays on.
 *
 * GM addresses 16 channels and scores exceed that, so the worklet hosts
 * several synth instances. Channel 9 is percussion by convention and
 * fluidsynth maps it that way by default — the spike found that selecting a
 * program on it *silences* it, so it is left alone. A second percussion track
 * takes an ordinary channel switched to drum type instead of forcing a whole
 * extra instance for its channel 9.
 */
export type ChannelAssignment = { instance: number; channel: number; isPercussion: boolean };
export type AllocatorTrack = { id: string; isPercussion: boolean };

const CHANNELS_PER_INSTANCE = 16;
const PERCUSSION_CHANNEL = 9;

export function allocateChannels(tracks: readonly AllocatorTrack[]): {
  assignments: Map<string, ChannelAssignment>;
  instanceCount: number;
} {
  const assignments = new Map<string, ChannelAssignment>();
  const used = new Set<string>();
  let instanceCount = 1;

  const take = (instance: number, channel: number): void => {
    used.add(`${instance}:${channel}`);
    instanceCount = Math.max(instanceCount, instance + 1);
  };
  const free = (instance: number, channel: number): boolean => !used.has(`${instance}:${channel}`);

  // Percussion first, so the natural channel 9 slots go to the tracks that
  // benefit from fluidsynth's default mapping.
  for (const track of tracks.filter((t) => t.isPercussion)) {
    let placed = false;
    for (let instance = 0; !placed; instance += 1) {
      if (free(instance, PERCUSSION_CHANNEL)) {
        take(instance, PERCUSSION_CHANNEL);
        assignments.set(track.id, { instance, channel: PERCUSSION_CHANNEL, isPercussion: true });
        placed = true;
      }
    }
  }

  for (const track of tracks.filter((t) => !t.isPercussion)) {
    let placed = false;
    for (let instance = 0; !placed; instance += 1) {
      for (let channel = 0; channel < CHANNELS_PER_INSTANCE && !placed; channel += 1) {
        if (channel === PERCUSSION_CHANNEL) continue;
        if (!free(instance, channel)) continue;
        take(instance, channel);
        assignments.set(track.id, { instance, channel, isPercussion: false });
        placed = true;
      }
    }
  }

  return { assignments, instanceCount };
}
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `bunx vitest run src/web/playback/channel-allocator.test.ts` — expect 5 passed.
Then `bun run typecheck && bun run lint`.

Note the second-drum-track test: with this implementation `d2` lands on instance 1 channel 9, which satisfies `isPercussion: true` and `channel !== 9` **fails**. Fix by allocating extra percussion tracks to a non-9 channel on an existing instance before opening a new one, and mark them for `midiSetChannelType`. Adjust the loop so only the *first* percussion track per instance uses channel 9.

- [ ] **Step 5: Commit**

```bash
git add src/web/playback/channel-allocator.ts src/web/playback/channel-allocator.test.ts
git commit -m "feat(playback): channel allocation across synth instances"
```

---

### Task 3: PlaybackClock

Retiring Tone means retiring `Tone.Transport`, so position becomes ours.

**Files:**
- Create: `src/web/playback/clock.ts`
- Test: `src/web/playback/clock.test.ts`

**Interfaces:**
- Produces: `class PlaybackClock` with `constructor(now: () => number)`, `start(fromSeconds?: number): void`, `pause(): void`, `stop(): void`, `seek(seconds: number): void`, `get positionSeconds(): number`, `get isRunning(): boolean`, `setRate(rate: number): void`.

`now` is injected so tests use a fake clock rather than real time.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { PlaybackClock } from './clock.js';

function fake() {
  const state = { t: 0 };
  return { state, clock: new PlaybackClock(() => state.t) };
}

describe('PlaybackClock', () => {
  it('advances with the injected clock only while running', () => {
    const { state, clock } = fake();
    clock.start();
    state.t = 2;
    expect(clock.positionSeconds).toBeCloseTo(2, 6);
    clock.pause();
    state.t = 5;
    expect(clock.positionSeconds).toBeCloseTo(2, 6);
  });

  it('resumes from where it paused', () => {
    const { state, clock } = fake();
    clock.start();
    state.t = 2;
    clock.pause();
    state.t = 10;
    clock.start();
    state.t = 11;
    expect(clock.positionSeconds).toBeCloseTo(3, 6);
  });

  it('stop returns to zero', () => {
    const { state, clock } = fake();
    clock.start();
    state.t = 4;
    clock.stop();
    expect(clock.positionSeconds).toBe(0);
    expect(clock.isRunning).toBe(false);
  });

  it('seeks while running without losing the rate', () => {
    const { state, clock } = fake();
    clock.start();
    state.t = 1;
    clock.seek(30);
    state.t = 2;
    expect(clock.positionSeconds).toBeCloseTo(31, 6);
  });

  it('rate scales elapsed time, for the playback-speed control', () => {
    const { state, clock } = fake();
    clock.setRate(2);
    clock.start();
    state.t = 3;
    expect(clock.positionSeconds).toBeCloseTo(6, 6);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bunx vitest run src/web/playback/clock.test.ts`
Expected: FAIL — cannot resolve `./clock.js`.

- [ ] **Step 3: Implement**

```ts
/**
 * Playback position, owned by us rather than by Tone's Transport.
 *
 * `now` is injected — the engine passes the AudioContext's `currentTime`, so
 * position is measured on the same clock the audio is rendered against, and
 * tests pass a fake.
 */
export class PlaybackClock {
  private running = false;
  private anchorNow = 0;
  private anchorPosition = 0;
  private rate = 1;

  constructor(private readonly now: () => number) {}

  start(fromSeconds?: number): void {
    if (fromSeconds !== undefined) this.anchorPosition = fromSeconds;
    else this.anchorPosition = this.positionSeconds;
    this.anchorNow = this.now();
    this.running = true;
  }

  pause(): void {
    if (!this.running) return;
    this.anchorPosition = this.positionSeconds;
    this.running = false;
  }

  stop(): void {
    this.running = false;
    this.anchorPosition = 0;
    this.anchorNow = this.now();
  }

  seek(seconds: number): void {
    this.anchorPosition = seconds;
    this.anchorNow = this.now();
  }

  /** Elapsed real time scales by `rate`, which is the playback-speed control. */
  setRate(rate: number): void {
    this.anchorPosition = this.positionSeconds;
    this.anchorNow = this.now();
    this.rate = rate;
  }

  get positionSeconds(): number {
    if (!this.running) return this.anchorPosition;
    return this.anchorPosition + (this.now() - this.anchorNow) * this.rate;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `bunx vitest run src/web/playback/clock.test.ts` — expect 5 passed.
Then `bun run typecheck && bun run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/web/playback/clock.ts src/web/playback/clock.test.ts
git commit -m "feat(playback): own the playback clock"
```

---

### Task 4: Pump dispatch rule

The pump's *decision* logic is pure and testable; the posting is not. Separate them so the rule is covered.

**Files:**
- Create: `src/web/playback/pump-window.ts`
- Test: `src/web/playback/pump-window.test.ts`

**Interfaces:**
- Consumes: `ScheduledNote` from `./schedule.js`.
- Produces: `type Dispatch = { note: ScheduledNote; atSeconds: number }`, and `function planDispatch(args: { notes: readonly ScheduledNote[]; secondsForTick: (tick: number) => number; positionSeconds: number; graceSeconds: number }): { due: Dispatch[]; skipped: ScheduledNote[] }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { planDispatch } from './pump-window.js';
import type { ScheduledNote } from './schedule.js';

const note = (tick: number, id: string): ScheduledNote => ({
  tick, durTicks: 240, midi: 60, velocity: 90, trackId: 't', noteId: id,
});
const secondsForTick = (tick: number): number => tick / 480; // 1 beat = 1s

describe('planDispatch', () => {
  it('stamps each note with the moment it should sound', () => {
    const { due } = planDispatch({
      notes: [note(480, 'a')], secondsForTick, positionSeconds: 0.5, graceSeconds: 0.2,
    });
    expect(due).toEqual([{ note: note(480, 'a'), atSeconds: 1 }]);
  });

  it('skips a note already past due beyond the grace window, rather than firing it late', () => {
    // The failure this prevents: after a stall, a backlog arriving at once.
    const { due, skipped } = planDispatch({
      notes: [note(0, 'old')], secondsForTick, positionSeconds: 5, graceSeconds: 0.2,
    });
    expect(due).toEqual([]);
    expect(skipped.map((n) => n.noteId)).toEqual(['old']);
  });

  it('still plays a note only slightly late, since the ear will not notice', () => {
    const { due, skipped } = planDispatch({
      notes: [note(480, 'a')], secondsForTick, positionSeconds: 1.1, graceSeconds: 0.2,
    });
    expect(due.map((d) => d.note.noteId)).toEqual(['a']);
    expect(skipped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bunx vitest run src/web/playback/pump-window.test.ts`
Expected: FAIL — cannot resolve `./pump-window.js`.

- [ ] **Step 3: Implement**

```ts
/**
 * What the pump does with the notes it drained, as pure logic.
 *
 * Kept apart from the posting so the rule that matters can be tested: a note
 * whose moment has already passed by more than the grace window is skipped
 * rather than fired late. Without that, a main-thread stall turns into a
 * backlog that arrives all at once and garbles the passage.
 */
import type { ScheduledNote } from './schedule.js';

export type Dispatch = { note: ScheduledNote; atSeconds: number };

export function planDispatch({
  notes,
  secondsForTick,
  positionSeconds,
  graceSeconds,
}: {
  notes: readonly ScheduledNote[];
  secondsForTick: (tick: number) => number;
  positionSeconds: number;
  graceSeconds: number;
}): { due: Dispatch[]; skipped: ScheduledNote[] } {
  const due: Dispatch[] = [];
  const skipped: ScheduledNote[] = [];
  for (const note of notes) {
    const atSeconds = secondsForTick(note.tick);
    if (positionSeconds - atSeconds > graceSeconds) skipped.push(note);
    else due.push({ note, atSeconds });
  }
  return { due, skipped };
}
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `bunx vitest run src/web/playback/pump-window.test.ts` — expect 3 passed.
Then `bun run typecheck && bun run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/web/playback/pump-window.ts src/web/playback/pump-window.test.ts
git commit -m "feat(playback): pump dispatch rule with a late-note grace window"
```

---

### Task 5: SoundfontLoader

**Files:**
- Create: `src/web/playback/soundfont-loader.ts`
- Test: `src/web/playback/soundfont-loader.test.ts`

**Interfaces:**
- Produces: `type LoadProgress = { loaded: number; total: number }`, `function loadSoundfont(url: string, opts?: { onProgress?: (p: LoadProgress) => void; cache?: Cache | null }): Promise<ArrayBuffer>`.

Cache API keyed by `url`. On a cache hit, no network. `cache` is injected so tests pass a stub rather than needing a real `CacheStorage`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { loadSoundfont } from './soundfont-loader.js';

const bytes = (n: number): ArrayBuffer => new Uint8Array(n).buffer;

function stubCache(initial?: ArrayBuffer) {
  const store = new Map<string, Response>();
  if (initial) store.set('font', new Response(initial));
  return {
    store,
    cache: {
      match: async (k: string) => store.get(String(k)),
      put: async (k: string, r: Response) => { store.set(String(k), r); },
    } as unknown as Cache,
  };
}

describe('loadSoundfont', () => {
  it('fetches and caches on a miss', async () => {
    const { cache, store } = stubCache();
    const fetchSpy = vi.fn(async () => new Response(bytes(8)));
    vi.stubGlobal('fetch', fetchSpy);
    const buf = await loadSoundfont('font', { cache });
    expect(buf.byteLength).toBe(8);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.has('font')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('does not touch the network on a cache hit', async () => {
    const { cache } = stubCache(bytes(4));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const buf = await loadSoundfont('font', { cache });
    expect(buf.byteLength).toBe(4);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('surfaces a failed fetch rather than resolving empty', async () => {
    const { cache } = stubCache();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(loadSoundfont('font', { cache })).rejects.toThrow(/404/);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bunx vitest run src/web/playback/soundfont-loader.test.ts`
Expected: FAIL — cannot resolve `./soundfont-loader.js`.

- [ ] **Step 3: Implement**

```ts
/**
 * Fetches the soundfont once and keeps it in the Cache API.
 *
 * The font is tens of megabytes, so this is the difference between a wait on
 * every visit and a wait on the first. `cache` is injected so tests need no
 * real CacheStorage.
 */
export type LoadProgress = { loaded: number; total: number };

export async function loadSoundfont(
  url: string,
  opts: { onProgress?: (p: LoadProgress) => void; cache?: Cache | null } = {},
): Promise<ArrayBuffer> {
  const cache = opts.cache;
  const hit = await cache?.match(url);
  if (hit) return await hit.arrayBuffer();

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Soundfont fetch failed: ${response.status} ${url}`);

  const total = Number(response.headers.get('content-length') ?? 0);
  opts.onProgress?.({ loaded: 0, total });

  const buffer = await response.clone().arrayBuffer();
  opts.onProgress?.({ loaded: buffer.byteLength, total: total || buffer.byteLength });
  await cache?.put(url, response);
  return buffer;
}
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `bunx vitest run src/web/playback/soundfont-loader.test.ts` — expect 3 passed.
Then `bun run typecheck && bun run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/web/playback/soundfont-loader.ts src/web/playback/soundfont-loader.test.ts
git commit -m "feat(playback): cache-backed soundfont loader"
```

---

### Task 6: SynthHost

The one module that touches `js-synthesizer`. Not unit tested — the same honest limit `renderOffline` has, for the same reason.

**Files:**
- Create: `src/web/playback/synth-host.ts`
- Modify: `package.json` (add `js-synthesizer` dependency)

**Interfaces:**
- Consumes: `loadSoundfont` (Task 5), `headroomTrimFor`/`LIMITER_CEILING_DB` from `./mix.js`.
- Produces: `class SynthHost` with `init(ctx: AudioContext, opts: { fontUrl: string; instanceCount: number; onProgress?: (p: LoadProgress) => void }): Promise<void>`, `noteOn(instance, channel, midi, velocity, atSeconds)`, `noteOff(instance, channel, midi, atSeconds)`, `programSelect(instance, channel, program)`, `setChannelPercussion(instance, channel)`, `controlChange(instance, channel, cc, value)`, `allSoundOff()`, `setInterpolation(order: number)`, `setMasterTrim(trim: number)`, `dispose()`.

- [ ] **Step 1: Add the dependency**

```bash
cd ~/projects/music_io && bun add js-synthesizer
```

- [ ] **Step 2: Implement**

Key rules, all from the spike:

```ts
// Load order matters: the fluidsynth module must be added before the worklet.
await ctx.audioWorklet.addModule(new URL('js-synthesizer/externals/libfluidsynth-2.4.6-with-libsndfile.js', import.meta.url).href);
await ctx.audioWorklet.addModule(new URL('js-synthesizer/dist/js-synthesizer.worklet.min.js', import.meta.url).href);
```

- One `AudioWorkletNodeSynthesizer` per instance; each `createAudioNode(ctx, 8192)`.
- All instances connect to a shared `GainNode` (the master trim) → `DynamicsCompressorNode` is **not** used; use a limiter equivalent by setting the gain and relying on the existing `LIMITER_CEILING_DB` shape — connect master gain → `Tone`-free limiter implemented as a `WaveShaperNode` soft clip, or simply keep the gain trim and document that the limiter is added in Task 11's governor work if measurement shows peaks above full scale (the spike measured 1.004).
- **`programSelect` must not be called when the channel is percussion.** Guard it:

```ts
programSelect(instance: number, channel: number, program: number): void {
  if (this.percussionChannels.has(`${instance}:${channel}`)) return; // silences the channel — see spike
  this.synths[instance].midiProgramSelect(channel, this.sfontIds[instance], 0, program);
}
```

- `setChannelPercussion` calls `midiSetChannelType(channel, 1)` and records the channel so `programSelect` skips it.
- Timing: convert `atSeconds` (audio-context time) to the synth's expectation. `js-synthesizer`'s `midiNoteOn` applies immediately, so events are posted by the pump only when their moment is within the lookahead; sample-accurate placement is a follow-up once basic playback is verified.

- [ ] **Step 3: Verify by hand in a browser**

Serve the app, load a score, press play, confirm audio. There is no unit test for this module; this step is the check.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock src/web/playback/synth-host.ts
git commit -m "feat(playback): worklet-hosted fluidsynth host"
```

---

### Task 7: SoundfontPlaybackEngine

**Files:**
- Create: `src/web/playback/soundfont-engine.ts`
- Test: `src/web/playback/soundfont-engine.test.ts`

**Interfaces:**
- Consumes: `NoteQueue`, `allocateChannels`, `PlaybackClock`, `planDispatch`, `SynthHost`.
- Produces: `class SoundfontPlaybackEngine implements PlaybackEngine` (the interface in `@sudobility/music_types`, unchanged).

Mixing: volume → CC7 (`value = Math.round(volume * 127)`), pan → CC10 (`Math.round((pan + 1) / 2 * 127)`), mute/solo → CC7 of 0. Mute/solo semantics unchanged: if anything is soloed, only soloed tracks sound.

- [ ] **Step 1: Write the failing test**

Test against a stub `SynthHost` injected through the constructor, so no audio is needed:

```ts
import { describe, expect, it, vi } from 'vitest';
import { SoundfontPlaybackEngine } from './soundfont-engine.js';
import { twoTrackScore } from '@sudobility/music_lib';

function stubHost() {
  return {
    init: vi.fn(async () => {}), noteOn: vi.fn(), noteOff: vi.fn(),
    programSelect: vi.fn(), setChannelPercussion: vi.fn(), controlChange: vi.fn(),
    allSoundOff: vi.fn(), setInterpolation: vi.fn(), setMasterTrim: vi.fn(), dispose: vi.fn(),
  };
}

describe('SoundfontPlaybackEngine', () => {
  it('sends each track its volume as CC7 and pan as CC10 on load', async () => {
    const host = stubHost();
    const engine = new SoundfontPlaybackEngine({ host, fontUrl: 'f' });
    const score = twoTrackScore();
    await engine.loadScore(score);
    const ccs = host.controlChange.mock.calls.map((c) => c[2]);
    expect(ccs).toContain(7);
    expect(ccs).toContain(10);
  });

  it('mutes a track by sending CC7 zero, and restores its volume on unmute', async () => {
    const host = stubHost();
    const engine = new SoundfontPlaybackEngine({ host, fontUrl: 'f' });
    const score = twoTrackScore();
    await engine.loadScore(score);
    host.controlChange.mockClear();
    engine.setTrackMute(score.tracks[0].id, true);
    expect(host.controlChange).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), 7, 0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bunx vitest run src/web/playback/soundfont-engine.test.ts`
Expected: FAIL — cannot resolve `./soundfont-engine.js`.

- [ ] **Step 3: Implement**

Wire `loadScore` → `flattenScoreForPlayback` → `NoteQueue.load`, `allocateChannels` → `programSelect`/`setChannelPercussion`/CC7/CC10. `play` starts the clock and the pump interval (50ms). The pump drains to `positionSeconds + 0.2` and calls `planDispatch`, then `host.noteOn`/`noteOff`. Observer: `onPositionTick` at 30Hz from the clock, `onActiveNotes` **coalesced to 30Hz** rather than per note.

- [ ] **Step 4: Run tests and confirm they pass**

Run: `bunx vitest run src/web/playback/soundfont-engine.test.ts`
Then `bun run typecheck && bun run lint && bun run test`.

- [ ] **Step 5: Commit**

```bash
git add src/web/playback/soundfont-engine.ts src/web/playback/soundfont-engine.test.ts
git commit -m "feat(playback): soundfont engine implementing PlaybackEngine"
```

---

### Task 8: Switch the web entry over

**Files:**
- Modify: `src/web/index.ts`

- [ ] **Step 1: Point `createMusicIo` at the new engine**

```ts
playback: new SoundfontPlaybackEngine({ fontUrl: SOUNDFONT_URL }),
```

- [ ] **Step 2: Verify by hand**

Load the app, play a multitrack score, confirm audio, drums, mute/solo, seek and tempo change.

- [ ] **Step 3: Run the full suite**

Run: `bun run typecheck && bun run lint && bun run test`

- [ ] **Step 4: Commit**

```bash
git add src/web/index.ts
git commit -m "feat(playback): use the soundfont engine on web"
```

---

### Task 9: Offline export through the same synth

**Files:**
- Modify: `src/web/audio/render.ts`

- [ ] **Step 1: Replace `Tone.Offline` with an `OfflineAudioContext` + `SynthHost`**

Same graph as playback, so export matches by construction. `RenderPlan`'s `tracks` drive `allocateChannels` exactly as `loadScore` does.

- [ ] **Step 2: Verify by exporting a WAV from the app and listening**

- [ ] **Step 3: Commit**

```bash
git add src/web/audio/render.ts
git commit -m "feat(export): render through the soundfont engine"
```

---

### Task 10: Metronome without Tone

**Files:**
- Modify: `src/web/playback/metronome.ts`

- [ ] **Step 1: Replace the `Tone.Synth` click with a generated buffer**

A short sine burst rendered once into an `AudioBuffer`, played through `AudioBufferSourceNode` at the scheduled time. Accent and beat differ in frequency, as now (1500Hz / 1000Hz, 0.03s).

- [ ] **Step 2: Run the suite and verify the click by hand**

- [ ] **Step 3: Commit**

```bash
git add src/web/playback/metronome.ts
git commit -m "refactor(playback): metronome without Tone"
```

---

### Task 11: Governor

**Files:**
- Create: `src/web/playback/governor.ts`
- Test: `src/web/playback/governor.test.ts`

**Interfaces:**
- Produces: `class Governor` with `record(lateBySeconds: number): void`, `get interpolation(): number`, and a callback `onChange(order: number)`.

Ladder: interpolation 7 → 4 → 1 → 0 as lateness persists; back up when it recovers. Hysteresis so it cannot oscillate. Polyphony is **not** a rung — fluidsynth steals voices at its default (see spike).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { Governor } from './governor.js';

describe('Governor', () => {
  it('steps interpolation down only after lateness persists', () => {
    const g = new Governor();
    expect(g.interpolation).toBe(7);
    for (let i = 0; i < 10; i++) g.record(0.15);
    expect(g.interpolation).toBeLessThan(7);
  });

  it('does not step down on a single late frame', () => {
    const g = new Governor();
    g.record(0.15);
    expect(g.interpolation).toBe(7);
  });

  it('recovers when lateness clears', () => {
    const g = new Governor();
    for (let i = 0; i < 20; i++) g.record(0.2);
    const degraded = g.interpolation;
    for (let i = 0; i < 60; i++) g.record(0);
    expect(g.interpolation).toBeGreaterThan(degraded);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bunx vitest run src/web/playback/governor.test.ts`

- [ ] **Step 3: Implement, then run and confirm the tests pass**

- [ ] **Step 4: Commit**

```bash
git add src/web/playback/governor.ts src/web/playback/governor.test.ts
git commit -m "feat(playback): adaptive interpolation governor"
```

---

### Task 12: Retire Tone

Only after Tasks 8–10 are verified by hand.

**Files:**
- Delete: `src/web/playback/instruments/`, `mixer.ts`, `audition.ts`, `tone-engine.ts`, `tone-engine.test.ts`, `instruments.test.ts`, `src/rn/`
- Modify: `package.json` (drop `tone`, `react-native-audio-api`, remove the `./rn` export), `src/web/index.ts`

- [ ] **Step 1: Delete the Tone engine and the RN entry**

- [ ] **Step 2: Confirm nothing imports `tone`**

Run: `grep -rn "from 'tone'" src/` — expect no results.

- [ ] **Step 3: Run the full suite, typecheck and lint**

- [ ] **Step 4: Commit with a major version bump**

Removing the `./rn` public entry is breaking.

```bash
git add -A
git commit -m "feat(playback)!: retire the Tone.js engine"
```

---

## Self-review

**Spec coverage.** Queue (Task 1), channels (2), clock (3), pump rule (4), loader (5), worklet host (6), engine and mixing (7), web wiring (8), offline export (9), metronome (10), governor (11), retirement (12). The spec's observer-batching item is folded into Task 7 rather than having its own task, since it is a property of the engine's observer wiring.

**Known gap, deliberately left.** Task 6's sample-accurate event placement is described as a follow-up: `js-synthesizer`'s `midiNoteOn` applies immediately, so the first working version relies on the pump's 50ms cadence rather than sample stamps. This is the one place the plan does not yet deliver the spec's timing guarantee, and it should be closed before Task 12 retires the fallback. Verify against the spike's `render` member, which suggests an offline path that may also accept timed events.

**Task 2 caveat.** The written implementation fails its own fourth test (a second drum track lands on instance 1 channel 9). The step notes this and states the fix. An implementer must resolve it rather than weaken the test.

**Type consistency.** `ScheduledNote` is used as defined in `schedule.ts` throughout. `ChannelAssignment` is produced in Task 2 and consumed in Task 7. `LoadProgress` is produced in Task 5 and consumed in Task 6.
