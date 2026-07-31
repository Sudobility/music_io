import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Measure, NoteEvent, Score, Track } from '@sudobility/music_types';
import { TempoMap } from '../../domain/time/tempo-map.js';
import { twinkleScore, twoTrackScore } from '../../test/fixtures.js';

// A mocked `tone` module covering everything both tone-engine.ts and
// instruments.ts touch: a singleton mock Transport whose schedule/
// scheduleRepeat calls are recorded (and fired manually by tests, rather
// than via a real audio clock/fake timers) plus lightweight mock instrument/
// node classes. `vi.hoisted` is required because `vi.mock`'s factory is
// hoisted above ordinary top-level `const`s.
const { mock, resetMockTone } = vi.hoisted(() => {
  type ScheduledEvent = { id: number; time: number; callback: (time: number) => void };
  type ConstructedNode = { type: string; options: unknown; instance: MockAudioNode };

  class MockAudioNode {
    connect = vi.fn();
    dispose = vi.fn();
    toDestination(): this {
      return this;
    }
  }
  class MockInstrumentNode extends MockAudioNode {
    triggerAttackRelease = vi.fn();
  }

  const state = {
    startCalls: 0,
    nextEventId: 1,
    scheduledEvents: [] as ScheduledEvent[],
    constructedNodes: [] as ConstructedNode[],
    transport: null as ReturnType<typeof makeTransport> | null,
  };

  function record(type: string, options: unknown, instance: MockAudioNode): void {
    state.constructedNodes.push({ type, options, instance });
  }

  function makeTransport() {
    return {
      bpm: { value: 120 },
      _state: 'stopped' as 'stopped' | 'started' | 'paused',
      get state() {
        return this._state;
      },
      seconds: 0,
      loopStart: 0 as number | string,
      loopEnd: 0 as number | string,
      loop: false,
      schedule(callback: (time: number) => void, time: number): number {
        const id = state.nextEventId++;
        state.scheduledEvents.push({ id, time, callback });
        return id;
      },
      scheduleRepeat(callback: (time: number) => void, interval: number): number {
        void interval; // signature-compatible with the real Transport; the mock doesn't need to actually repeat.
        const id = state.nextEventId++;
        state.scheduledEvents.push({ id, time: 0, callback });
        return id;
      },
      clear(id: number): void {
        state.scheduledEvents = state.scheduledEvents.filter((e) => e.id !== id);
      },
      cancel(after = 0): void {
        state.scheduledEvents = state.scheduledEvents.filter((e) => e.time < after);
      },
      // Wrapped in vi.fn (rather than plain methods) so tests can assert
      // call counts directly (finding 1's play/stop race regression test
      // needs to assert transport.start() was never called), not just the
      // resulting `_state`. `function` (not an arrow) preserves `this`
      // binding for `obj.start()`-style calls.
      start: vi.fn(function (this: { _state: string; seconds: number }, _time?: unknown, offset?: number): void {
        this._state = 'started';
        if (typeof offset === 'number') this.seconds = offset;
      }),
      stop: vi.fn(function (this: { _state: string }): void {
        this._state = 'stopped';
      }),
      pause: vi.fn(function (this: { _state: string }): void {
        this._state = 'paused';
      }),
    };
  }

  return {
    mock: {
      state,
      record,
      MockAudioNode,
      MockInstrumentNode,
      getTransport(): ReturnType<typeof makeTransport> {
        if (!state.transport) state.transport = makeTransport();
        return state.transport;
      },
      /** Directly invokes the callback for a still-scheduled event by id, simulating the Transport clock reaching it (no fake timers needed). */
      fire(id: number, time = 0): void {
        state.scheduledEvents.find((e) => e.id === id)?.callback(time);
      },
    },
    resetMockTone(): void {
      state.startCalls = 0;
      state.nextEventId = 1;
      state.scheduledEvents = [];
      state.constructedNodes = [];
      state.transport = null;
    },
  };
});

vi.mock('tone', () => {
  class Gain extends mock.MockAudioNode {
    gain = { value: 1 };
    constructor(public value?: number) {
      super();
      this.gain.value = value ?? 1;
      mock.record('Gain', { value }, this);
    }
  }
  class Panner extends mock.MockAudioNode {
    constructor(public pan?: number) {
      super();
      mock.record('Panner', { pan }, this);
    }
  }
  class Filter extends mock.MockAudioNode {
    constructor(
      public frequency?: number,
      public filterType?: string,
    ) {
      super();
      mock.record('Filter', { frequency, filterType }, this);
    }
  }
  class Synth extends mock.MockInstrumentNode {
    constructor(public options?: unknown) {
      super();
      mock.record('Synth', options, this);
    }
  }
  class FMSynth extends mock.MockInstrumentNode {
    constructor(public options?: unknown) {
      super();
      mock.record('FMSynth', options, this);
    }
  }
  class MonoSynth extends mock.MockInstrumentNode {
    constructor(public options?: unknown) {
      super();
      mock.record('MonoSynth', options, this);
    }
  }
  class MembraneSynth extends mock.MockInstrumentNode {
    constructor(public options?: unknown) {
      super();
      mock.record('MembraneSynth', options, this);
    }
  }
  class NoiseSynth extends mock.MockInstrumentNode {
    constructor(public options?: unknown) {
      super();
      mock.record('NoiseSynth', options, this);
    }
  }
  class Sampler extends mock.MockInstrumentNode {
    constructor(public options?: unknown) {
      super();
      mock.record('Sampler', options, this);
    }
  }
  class PolySynth extends mock.MockInstrumentNode {
    constructor(
      public voice?: unknown,
      public options?: unknown,
    ) {
      super();
      mock.record('PolySynth', { voice, options }, this);
    }
  }
  return {
    Gain,
    Panner,
    Filter,
    Synth,
    FMSynth,
    MonoSynth,
    MembraneSynth,
    NoiseSynth,
    Sampler,
    PolySynth,
    start: vi.fn(async () => {
      mock.state.startCalls += 1;
    }),
    getTransport: mock.getTransport,
  };
});

import * as Tone from 'tone';
import { TonePlaybackEngine } from './tone-engine.js';
import type { PlaybackObserver } from '../../services/playback/types.js';

const PPQ = 480;
const C_MAJOR = { fifths: 0, mode: 'major' as const };
const FOUR_FOUR = { numerator: 4, denominator: 4 };

function tiedAcrossBarlineScore(): Score {
  const trackId = 'track-1';
  const voiceId = 'voice-1';
  const measureTicks = PPQ * 4;

  const tieStart: NoteEvent = {
    id: 'note-tie-start',
    pitch: { step: 'C', accidental: 0, octave: 4 },
    startTick: measureTicks - PPQ,
    durationTicks: PPQ,
    velocity: 90,
    voiceId,
    trackId,
    tieStart: true,
  };
  const tieStop: NoteEvent = {
    id: 'note-tie-stop',
    pitch: { step: 'C', accidental: 0, octave: 4 },
    startTick: measureTicks,
    durationTicks: PPQ,
    velocity: 90,
    voiceId,
    trackId,
    tieStop: true,
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
    voices: [{ id: voiceId, name: 'Voice 1', events: [tieStop] }],
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

function makeObserver(): PlaybackObserver & {
  positions: number[];
  activeNoteSnapshots: string[][];
  states: string[];
} {
  const positions: number[] = [];
  const activeNoteSnapshots: string[][] = [];
  const states: string[] = [];
  return {
    positions,
    activeNoteSnapshots,
    states,
    onPositionTick: (tick) => positions.push(tick),
    onActiveNotes: (ids) => activeNoteSnapshots.push(ids),
    onStateChange: (state) => states.push(state),
  };
}

/** Ids of every `transport.schedule`d "note on" callback still pending, in the order they were scheduled (on, off, on, off, ...; the position ticker is scheduled last via `scheduleRepeat` and isn't included here). */
function noteEventIds(): number[] {
  return mock.state.scheduledEvents.map((e) => e.id);
}

/** Narrows a constructed node's `instance` (typed as the common `MockAudioNode` base) to the `MockInstrumentNode` subtype that actually has `triggerAttackRelease`, for nodes we know are instruments (PolySynth/Synth/etc, never Gain/Panner/Filter). */
function asInstrumentInstance(node: {
  instance: InstanceType<typeof mock.MockAudioNode>;
}): InstanceType<typeof mock.MockInstrumentNode> {
  return node.instance as InstanceType<typeof mock.MockInstrumentNode>;
}

/** Narrows a constructed Gain node's `instance` to expose its `.gain.value`. */
function asGainInstance(node: { instance: InstanceType<typeof mock.MockAudioNode> }): { gain: { value: number } } {
  return node.instance as unknown as { gain: { value: number } };
}

beforeEach(() => {
  resetMockTone();
});

describe('TonePlaybackEngine.initialize', () => {
  it('starts Tone audio exactly once even if called repeatedly', async () => {
    const engine = new TonePlaybackEngine();
    await engine.initialize();
    await engine.initialize();
    expect(mock.state.startCalls).toBe(1);
  });

  it('fixes Transport bpm at 60', async () => {
    const engine = new TonePlaybackEngine();
    await engine.initialize();
    expect(mock.getTransport().bpm.value).toBe(60);
  });
});

describe('TonePlaybackEngine.loadScore: scheduling', () => {
  it('pins Transport bpm to 60 BEFORE scheduling, even when initialize() has never run', async () => {
    // Regression: Tone converts schedule(cb, seconds) to internal ticks at
    // the bpm current AT SCHEDULING TIME. loadScore() runs on project load,
    // before play() ever calls initialize() — under Tone's default bpm=120
    // every note landed at 2x its intended seconds once initialize() later
    // set bpm=60, while the position ticker (reading live transport.seconds)
    // stayed correct: the caret ran exactly twice as fast as the audio.
    const engine = new TonePlaybackEngine();
    expect(mock.getTransport().bpm.value).toBe(120); // Tone's default, pre-anything
    await engine.loadScore(twinkleScore());
    expect(mock.getTransport().bpm.value).toBe(60);
  });

  it('schedules one on/off pair per note, plus the end-of-score stop and a position-ticker repeat', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(twinkleScore());
    // twinkleScore has 28 note events (see schedule.test.ts) => 56 on/off events + 1 end-of-score stop + 1 ticker.
    expect(mock.state.scheduledEvents).toHaveLength(58);
  });

  it('builds one Gain+Panner channel per track and wires the instrument through them', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(twoTrackScore());
    const gains = mock.state.constructedNodes.filter((n) => n.type === 'Gain');
    const panners = mock.state.constructedNodes.filter((n) => n.type === 'Panner');
    // 2 tracks => 2 channel Gains + 1 master Gain; 2 Panners.
    expect(gains).toHaveLength(3);
    expect(panners).toHaveLength(2);
  });

  it('triggers the right instrument, at the right frequency/duration/velocity, when a note-on event fires', async () => {
    const engine = new TonePlaybackEngine();
    const score = twinkleScore();
    await engine.loadScore(score);

    const onEventId = noteEventIds()[0];
    mock.fire(onEventId, 0);

    const polySynth = asInstrumentInstance(mock.state.constructedNodes.find((n) => n.type === 'PolySynth')!);
    expect(polySynth.triggerAttackRelease).toHaveBeenCalledTimes(1);
    const [frequency, duration, , velocity] = polySynth.triggerAttackRelease.mock.calls[0];
    expect(frequency).toBeCloseTo(261.626, 1); // C4
    expect(duration).toBeCloseTo(0.5, 3); // quarter note at 120bpm = 0.5s
    expect(velocity).toBeCloseTo(80 / 127, 5);
  });

  it('reports active notes via the observer on note-on and note-off', async () => {
    const engine = new TonePlaybackEngine();
    const observer = makeObserver();
    engine.setObserver(observer);
    const score = twinkleScore();
    await engine.loadScore(score);

    const firstNoteId = score.tracks[0].measures[0].voices[0].events[0].id;
    const [onId, offId] = noteEventIds();
    mock.fire(onId, 0);
    expect(observer.activeNoteSnapshots.at(-1)).toEqual([firstNoteId]);

    mock.fire(offId, 0.5);
    expect(observer.activeNoteSnapshots.at(-1)).toEqual([]);
  });

  it('reschedules cleanly on a second loadScore (no leftover events from the first)', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(twinkleScore());
    const firstCount = mock.state.scheduledEvents.length;
    await engine.loadScore(twinkleScore());
    expect(mock.state.scheduledEvents).toHaveLength(firstCount);
  });
});

describe('TonePlaybackEngine.loadScore: tie joining', () => {
  it('schedules exactly one on/off pair for a note tied across a measure boundary', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(tiedAcrossBarlineScore());
    // 1 joined note => 2 events (on+off) + 1 end-of-score stop + 1 ticker.
    expect(mock.state.scheduledEvents).toHaveLength(4);
  });

  it('the joined note plays for the combined duration of both tied segments', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(tiedAcrossBarlineScore());
    const [onId] = noteEventIds();
    mock.fire(onId, 0);

    const polySynth = asInstrumentInstance(mock.state.constructedNodes.find((n) => n.type === 'PolySynth')!);
    const [, duration] = polySynth.triggerAttackRelease.mock.calls[0];
    // Two quarter notes at 120bpm => 1 second combined.
    expect(duration).toBeCloseTo(1, 3);
  });
});

describe('TonePlaybackEngine: mute/solo', () => {
  it('mutes a track by zeroing its channel gain, and restores it on unmute', async () => {
    const engine = new TonePlaybackEngine();
    const score = twoTrackScore();
    await engine.loadScore(score);
    const [trackA] = score.tracks;
    // Gain construction order: master gain (index 0), then one per track in order.
    const gain = asGainInstance(mock.state.constructedNodes.filter((n) => n.type === 'Gain')[1]);

    engine.setTrackMute(trackA.id, true);
    expect(gain.gain.value).toBe(0);

    engine.setTrackMute(trackA.id, false);
    expect(gain.gain.value).toBe(trackA.volume);
  });

  it('solo silences every non-soloed track, regardless of their own mute flag', async () => {
    const engine = new TonePlaybackEngine();
    const score = twoTrackScore();
    await engine.loadScore(score);
    const [trackA, trackB] = score.tracks;
    // Gain construction order: master gain (index 0), then one per track in order.
    const channelGains = mock.state.constructedNodes
      .filter((n) => n.type === 'Gain')
      .slice(1, 3)
      .map((n) => asGainInstance(n));

    engine.setTrackSolo(trackA.id, true);

    expect(channelGains[0].gain.value).toBe(trackA.volume); // soloed track A: audible
    expect(channelGains[1].gain.value).toBe(0); // non-soloed track B: silenced

    engine.setTrackSolo(trackA.id, false);
    expect(channelGains[1].gain.value).toBe(trackB.volume); // solo cleared: back to normal
  });

  it('a no-op setTrackMute for an unknown track id does not throw', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(twinkleScore());
    expect(() => engine.setTrackMute('does-not-exist', true)).not.toThrow();
  });
});

describe('TonePlaybackEngine: transport lifecycle', () => {
  it('play() initializes audio, starts the transport, and notifies the observer', async () => {
    const engine = new TonePlaybackEngine();
    const observer = makeObserver();
    engine.setObserver(observer);
    await engine.loadScore(twinkleScore());

    await engine.play();

    expect(mock.state.startCalls).toBe(1);
    expect(mock.getTransport().state).toBe('started');
    expect(observer.states).toEqual(['playing']);
  });

  it('play() is a no-op before any score is loaded', async () => {
    const engine = new TonePlaybackEngine();
    await engine.play();
    expect(mock.getTransport().state).toBe('stopped');
  });

  it('regression: stop() during the initial play() await wins the race (Tone.start() resolving late must not start the transport)', async () => {
    const engine = new TonePlaybackEngine();
    const observer = makeObserver();
    engine.setObserver(observer);
    await engine.loadScore(twinkleScore());

    let resolveStart!: () => void;
    vi.mocked(Tone.start).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );

    const playPromise = engine.play(); // suspends inside `await this.initialize()`, i.e. inside `await Tone.start()`
    engine.stop(); // completes synchronously well before Tone.start() resolves
    resolveStart();
    await playPromise;

    expect(mock.getTransport().start).not.toHaveBeenCalled();
    expect(mock.getTransport().state).toBe('stopped');
    expect(observer.states.at(-1)).toBe('stopped');
  });

  it('pause() pauses the transport, silences voices (instrument disposed+rebuilt), and notifies the observer', async () => {
    const engine = new TonePlaybackEngine();
    const observer = makeObserver();
    engine.setObserver(observer);
    await engine.loadScore(twinkleScore());
    await engine.play();

    const beforePolySynth = mock.state.constructedNodes.find((n) => n.type === 'PolySynth')!;
    engine.pause();

    expect(mock.getTransport().state).toBe('paused');
    expect(beforePolySynth.instance.dispose).toHaveBeenCalledTimes(1);
    expect(observer.states).toEqual(['playing', 'paused']);
  });

  it('stop() stops the transport, resets position, clears active notes, and is ready for another play()', async () => {
    const engine = new TonePlaybackEngine();
    const observer = makeObserver();
    engine.setObserver(observer);
    await engine.loadScore(twinkleScore());
    await engine.play();
    const [onId] = noteEventIds();
    mock.fire(onId, 0); // simulate a note sounding

    engine.stop();

    expect(mock.getTransport().state).toBe('stopped');
    expect(mock.getTransport().seconds).toBe(0);
    expect(observer.activeNoteSnapshots.at(-1)).toEqual([]);
    expect(observer.positions.at(-1)).toBe(0);
    expect(observer.states.at(-1)).toBe('stopped');
    // ready for the next play() without another loadScore():
    expect(mock.state.scheduledEvents.length).toBeGreaterThan(0);
  });

  it('regression: a note that fires after pause()/resume plays on the rebuilt instrument, not the disposed one', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(twinkleScore());
    await engine.play();

    const stalePolySynth = asInstrumentInstance(mock.state.constructedNodes.find((n) => n.type === 'PolySynth')!);
    engine.pause();
    // pause() must reschedule (not just rebuild channels), or every remaining
    // note-on callback still closes over the disposed pre-pause instrument.
    const freshPolySynths = mock.state.constructedNodes.filter((n) => n.type === 'PolySynth');
    expect(freshPolySynths.length).toBeGreaterThan(1);

    const [onId] = noteEventIds();
    mock.fire(onId, 0);

    expect(stalePolySynth.triggerAttackRelease).not.toHaveBeenCalled();
    expect(asInstrumentInstance(freshPolySynths.at(-1)!).triggerAttackRelease).toHaveBeenCalledTimes(1);
  });

  it('regression: a note that fires after seek() plays on the rebuilt instrument, not the disposed one', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(twinkleScore());

    const stalePolySynth = asInstrumentInstance(mock.state.constructedNodes.find((n) => n.type === 'PolySynth')!);
    engine.seek(0);
    const freshPolySynths = mock.state.constructedNodes.filter((n) => n.type === 'PolySynth');
    expect(freshPolySynths.length).toBeGreaterThan(1);

    const [onId] = noteEventIds();
    mock.fire(onId, 0);

    expect(stalePolySynth.triggerAttackRelease).not.toHaveBeenCalled();
    expect(asInstrumentInstance(freshPolySynths.at(-1)!).triggerAttackRelease).toHaveBeenCalledTimes(1);
  });
});

describe('TonePlaybackEngine: loop', () => {
  it('setLoop sets Transport loop points from tick range, in seconds', async () => {
    const engine = new TonePlaybackEngine();
    const score = twinkleScore();
    const tempoMap = new TempoMap(score.tempoMap, score.ppq);
    await engine.loadScore(score);

    engine.setLoop({ startTick: 0, endTick: PPQ * 4, trackIds: [] });

    const transport = mock.getTransport();
    expect(transport.loop).toBe(true);
    expect(transport.loopStart).toBeCloseTo(tempoMap.ticksToSeconds(0), 5);
    expect(transport.loopEnd).toBeCloseTo(tempoMap.ticksToSeconds(PPQ * 4), 5);
  });

  it('setLoop(null) disables looping', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(twinkleScore());
    engine.setLoop({ startTick: 0, endTick: PPQ, trackIds: [] });
    engine.setLoop(null);
    expect(mock.getTransport().loop).toBe(false);
  });
});

describe('TonePlaybackEngine: tempo multiplier', () => {
  it('halves scheduled seconds at 2x speed', async () => {
    const engine = new TonePlaybackEngine();
    const score = twinkleScore();
    const tempoMap = new TempoMap(score.tempoMap, score.ppq);
    await engine.loadScore(score);

    engine.setTempoMultiplier(2);

    // Scheduling order is deterministic (note0.on, note0.off, note1.on, ...);
    // the first note starts at tick 0 (time 0 regardless of multiplier), so
    // use the second note's on-event to actually distinguish the multiplier.
    const secondNoteOnId = noteEventIds()[2];
    const event = mock.state.scheduledEvents.find((e) => e.id === secondNoteOnId)!;
    const secondNoteTick = score.tracks[0].measures[0].voices[0].events[1].startTick;
    expect(event.time).toBeCloseTo(tempoMap.ticksToSeconds(secondNoteTick) / 2, 5);
  });

  it('keeps the transport playing (no restart) when changing speed mid-playback', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(twinkleScore());
    await engine.play();

    engine.setTempoMultiplier(1.5);

    expect(mock.getTransport().state).toBe('started');
  });
});

describe('TonePlaybackEngine: metronome', () => {
  it('setMetronome(true) schedules a click per beat without disturbing note events', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(twinkleScore());
    const beforeIds = new Set(noteEventIds());

    engine.setMetronome(true);

    const afterIds = noteEventIds();
    // every previous (note+ticker) id is still scheduled...
    for (const id of beforeIds) expect(afterIds).toContain(id);
    // ...plus 32 new metronome clicks (8 measures x 4 beats, see schedule.test.ts).
    expect(afterIds.length).toBe(beforeIds.size + 32);
  });

  it('setMetronome(false) clears only the metronome clicks', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(twinkleScore());
    const beforeIds = noteEventIds();
    engine.setMetronome(true);
    engine.setMetronome(false);
    expect(noteEventIds().sort()).toEqual(beforeIds.sort());
  });

  it('firing an accented click plays a higher pitch than a regular beat', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(twinkleScore());
    engine.setMetronome(true);

    const clickIds = noteEventIds().slice(-32);
    mock.fire(clickIds[0], 0); // beat 1 of measure 1: accented
    mock.fire(clickIds[1], 0); // beat 2: regular

    const synth = asInstrumentInstance(mock.state.constructedNodes.find((n) => n.type === 'Synth')!);
    const calls = synth.triggerAttackRelease.mock.calls;
    expect(calls[0][0]).toBeGreaterThan(calls[1][0]);
  });
});

describe('TonePlaybackEngine: master volume', () => {
  it('setMasterVolume updates the master Gain node', async () => {
    const engine = new TonePlaybackEngine();
    await engine.initialize();
    engine.setMasterVolume(0.4);
    const masterGain = mock.state.constructedNodes.find((n) => n.type === 'Gain')!;
    expect(asGainInstance(masterGain).gain.value).toBe(0.4);
  });
});

describe('TonePlaybackEngine: end-of-score auto-stop', () => {
  /** The auto-stop event is scheduled after every note on/off pair and before the ticker: second-to-last overall. */
  function endStopEventId(): number {
    return mock.state.scheduledEvents.at(-2)!.id;
  }

  it('stops the transport and reports stopped when the end-of-score event fires', async () => {
    const engine = new TonePlaybackEngine();
    const observer = makeObserver();
    engine.setObserver(observer);
    await engine.loadScore(twinkleScore());
    await engine.play();
    expect(mock.getTransport().state).toBe('started');

    mock.fire(endStopEventId());

    expect(mock.getTransport().state).toBe('stopped');
    expect(observer.states.at(-1)).toBe('stopped');
    expect(observer.positions.at(-1)).toBe(0);
  });

  it('schedules the stop after the score end tick (past the final note-offs)', async () => {
    const engine = new TonePlaybackEngine();
    const score = twinkleScore();
    await engine.loadScore(score);
    const endStop = mock.state.scheduledEvents.at(-2)!;
    const latestNoteOff = Math.max(...mock.state.scheduledEvents.slice(0, -2).map((e) => e.time));
    expect(endStop.time).toBeGreaterThan(latestNoteOff);
  });

  it('does nothing while a loop is active (the loop owns the transport past its end)', async () => {
    const engine = new TonePlaybackEngine();
    const observer = makeObserver();
    engine.setObserver(observer);
    await engine.loadScore(twinkleScore());
    engine.setLoop({ startTick: 0, endTick: 480, trackIds: [] });
    await engine.play();

    mock.fire(endStopEventId());

    expect(mock.getTransport().state).toBe('started');
    expect(observer.states.at(-1)).toBe('playing');
  });
});

describe('TonePlaybackEngine.dispose', () => {
  it('stops the transport, cancels all events, and disposes every node', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(twinkleScore());
    await engine.play();

    const nodesBeforeDispose = [...mock.state.constructedNodes];
    engine.dispose();

    expect(mock.getTransport().state).toBe('stopped');
    expect(mock.state.scheduledEvents).toHaveLength(0);
    for (const node of nodesBeforeDispose) {
      expect(node.instance.dispose).toHaveBeenCalled();
    }
  });
});

describe('TonePlaybackEngine: visibility', () => {
  const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

  afterEach(() => {
    if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
  });

  it('pauses playback when the document becomes hidden mid-play', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(twinkleScore());
    await engine.play();
    expect(mock.getTransport().state).toBe('started');

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(mock.getTransport().state).toBe('paused');
  });

  it('does not pause if already stopped when the document becomes hidden', async () => {
    const engine = new TonePlaybackEngine();
    await engine.loadScore(twinkleScore());
    await engine.initialize();

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(mock.getTransport().state).toBe('stopped');
  });
});

describe('TonePlaybackEngine: instrument failure isolation', () => {
  it('a throwing instrument trigger neither propagates nor suppresses the note-on highlight', async () => {
    const engine = new TonePlaybackEngine();
    const observer = makeObserver();
    engine.setObserver(observer);
    await engine.loadScore(twinkleScore());

    const polySynth = asInstrumentInstance(mock.state.constructedNodes.find((n) => n.type === 'PolySynth')!);
    polySynth.triggerAttackRelease.mockImplementationOnce(() => {
      throw new Error('Start time must be strictly greater than previous start time');
    });

    const onEventId = noteEventIds()[0];
    expect(() => mock.fire(onEventId, 0)).not.toThrow();
    expect(observer.activeNoteSnapshots.length).toBeGreaterThan(0);
  });
});
