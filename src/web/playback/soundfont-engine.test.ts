import { describe, expect, it, vi } from 'vitest';
import { twoTrackScore } from '@sudobility/music_lib';
import type { PlaybackLoadState, Score } from '@sudobility/music_types';
import { SoundfontPlaybackEngine } from './soundfont-engine.js';

/** Records everything the engine tells the synth host. */
function stubHost() {
  return {
    init: vi.fn(async () => {}),
    setChannelPercussion: vi.fn(),
    programSelect: vi.fn(),
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    controlChange: vi.fn(),
    allSoundOff: vi.fn(),
    setInterpolation: vi.fn(),
    setMasterVolume: vi.fn(),
    setTrackCount: vi.fn(),
    dispose: vi.fn(),
  };
}

/** Enough AudioContext for the metronome click, and nothing more. */
function stubContext() {
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  return {
    sampleRate: 44100,
    currentTime: 0,
    destination: { connect: vi.fn(), disconnect: vi.fn() },
    close: vi.fn(),
    createOscillator: vi.fn(() => ({
      frequency: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    })),
    createGain: vi.fn(() => ({ gain: param(), connect: vi.fn(), disconnect: vi.fn() })),
  } as unknown as AudioContext;
}

/** A pump we step by hand, so tests never wait on real time. */
function manualPump() {
  let tick: (() => void) | null = null;
  return {
    start: (cb: () => void) => {
      tick = cb;
      return () => {
        tick = null;
      };
    },
    step: () => tick?.(),
    get running() {
      return tick !== null;
    },
  };
}

function setup(score?: Score, createContext: () => AudioContext = () => stubContext()) {
  const host = stubHost();
  const pump = manualPump();
  const clock = { t: 0 };
  const engine = new SoundfontPlaybackEngine({
    host,
    moduleUrls: { fluidsynth: 'f.js', worklet: 'w.js' },
    fontUrl: 'font.sf3',
    loadFont: async () => new Uint8Array(4).buffer,
    createContext,
    now: () => clock.t,
    startPump: pump.start,
  });
  return { engine, host, pump, clock, score: score ?? twoTrackScore() };
}

describe('SoundfontPlaybackEngine: loading a score', () => {
  it('sends each track its volume as CC7 and its pan as CC10', async () => {
    const { engine, host, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);
    const controls = host.controlChange.mock.calls.map((c) => c[2]);
    expect(controls).toContain(7);
    expect(controls).toContain(10);
  });

  it('selects each track GM program', async () => {
    const { engine, host, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);
    const programs = host.programSelect.mock.calls.map((c) => c[2]);
    expect(programs).toEqual(score.tracks.map((t) => t.midiProgram));
  });

  it('marks a percussion-clef track as percussion and never selects a program on it', async () => {
    // Selecting a program on a percussion channel silences it — see the spike.
    const base = twoTrackScore();
    const score: Score = { ...base, tracks: [{ ...base.tracks[0], clef: 'percussion' }, base.tracks[1]] };
    const { engine, host } = setup(score);
    await engine.initialize();
    await engine.loadScore(score);

    expect(host.setChannelPercussion).toHaveBeenCalledTimes(1);
    expect(host.programSelect).toHaveBeenCalledTimes(1); // only the pitched track
  });

  it('tells the host how many channels are summing, which sizes the headroom', async () => {
    const { engine, host, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);
    expect(host.setTrackCount).toHaveBeenCalledWith(score.tracks.length);
  });
});

describe('SoundfontPlaybackEngine: mixing', () => {
  it('mutes by sending CC7 zero and restores the track volume on unmute', async () => {
    const { engine, host, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);
    const track = score.tracks[0];

    host.controlChange.mockClear();
    engine.setTrackMute(track.id, true);
    expect(host.controlChange).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), 7, 0);

    host.controlChange.mockClear();
    engine.setTrackMute(track.id, false);
    const restored = host.controlChange.mock.calls.find((c) => c[2] === 7);
    expect(restored?.[3]).toBe(Math.round(track.volume * 127));
  });

  it('solo silences every non-soloed track', async () => {
    const { engine, host, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);

    host.controlChange.mockClear();
    engine.setTrackSolo(score.tracks[0].id, true);

    const cc7 = host.controlChange.mock.calls.filter((c) => c[2] === 7);
    expect(cc7.some((c) => c[3] === 0)).toBe(true); // the non-soloed one
    expect(cc7.some((c) => c[3] > 0)).toBe(true); // the soloed one
  });
});

describe('SoundfontPlaybackEngine: bringing the synth up', () => {
  /** A context that starts suspended, as a browser gives you without a gesture. */
  function suspendableContext(): Record<string, unknown> {
    const base = stubContext() as unknown as Record<string, unknown>;
    base.state = 'suspended';
    base.resume = vi.fn(async () => {
      base.state = 'running';
    });
    return base;
  }

  it('does not touch the synth while the context is suspended', async () => {
    // A suspended context never runs its AudioWorklet, and the synth's font
    // load round-trips through it — so this would not fail, it would hang for
    // good, leaving the transport stuck at "stopped" with a clean console.
    const context = stubContext() as unknown as Record<string, unknown>;
    context.state = 'suspended';
    const { engine, host, score } = setup(undefined, () => context as never);
    await engine.initialize();
    await engine.loadScore(score);
    expect(host.init).not.toHaveBeenCalled();
  });

  it('resumes the context and brings the synth up when play is pressed', async () => {
    // Play is a user gesture, which is what makes resuming allowed.
    const context = suspendableContext();
    const { engine, host, score } = setup(undefined, () => context as never);
    await engine.loadScore(score);
    expect(host.init).not.toHaveBeenCalled();

    await engine.play();
    expect(context.resume as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(host.init).toHaveBeenCalled();
  });

  it('tells the host about a score that arrived before the synth existed', async () => {
    // loadScore no longer waits for the synth, so the programs and levels it
    // would have sent have to be sent once there is something to send them to.
    const context = suspendableContext();
    const { engine, host, score } = setup(undefined, () => context as never);
    await engine.loadScore(score);
    expect(host.programSelect).not.toHaveBeenCalled();

    await engine.play();
    expect(host.programSelect).toHaveBeenCalled();
    expect(host.setTrackCount).toHaveBeenCalledWith(score.tracks.length);
  });

  /** An engine whose soundfont does not arrive until the returned `release` is called. */
  function withPendingFont() {
    let release!: () => void;
    const font = new Promise<ArrayBuffer>((resolve) => {
      release = () => resolve(new Uint8Array(4).buffer);
    });
    const host = stubHost();
    const pump = manualPump();
    const context = suspendableContext();
    const engine = new SoundfontPlaybackEngine({
      host,
      moduleUrls: { fluidsynth: 'f.js', worklet: 'w.js' },
      fontUrl: 'font.sf3',
      loadFont: () => font,
      createContext: () => context as never,
      now: () => 0,
      startPump: pump.start,
    });
    return { engine, host, pump, release };
  }

  it('reports playing at once, without waiting for the soundfont', async () => {
    // The first press loads 23MB and hands it to fluidsynth. Waiting for that
    // before reporting left the button dead for seconds with nothing happening,
    // and under load the acceptance test gave up on it.
    const { engine, pump, release } = withPendingFont();
    const states: string[] = [];
    engine.setObserver({
      onPositionTick: () => {},
      onActiveNotes: () => {},
      onStateChange: (s) => states.push(s),
    });
    await engine.loadScore(twoTrackScore());

    const playing = engine.play();
    expect(states).toEqual(['playing']); // reported while the font is still loading
    expect(pump.running).toBe(false); // but nothing is dispatched yet

    release();
    await playing;
    expect(pump.running).toBe(true);
  });

  it('does not start playing if the user pauses while the synth loads', async () => {
    const { engine, pump, release } = withPendingFont();
    await engine.loadScore(twoTrackScore());

    const playing = engine.play();
    engine.pause();
    release();
    await playing;
    expect(pump.running).toBe(false);
  });

  it('reports fetch progress, then indeterminate, then ready', async () => {
    // Without this the transport looks broken for the whole load. The fetch is
    // the measurable half; handing the font to fluidsynth reports nothing.
    const host = stubHost();
    const context = suspendableContext();
    const engine = new SoundfontPlaybackEngine({
      host,
      moduleUrls: { fluidsynth: 'f.js', worklet: 'w.js' },
      fontUrl: 'font.sf3',
      loadFont: async (_url, onProgress) => {
        onProgress?.({ loaded: 50, total: 100 });
        onProgress?.({ loaded: 100, total: 100 });
        return new Uint8Array(4).buffer;
      },
      createContext: () => context as never,
      now: () => 0,
      startPump: manualPump().start,
    });
    const seen: PlaybackLoadState[] = [];
    engine.setObserver({
      onPositionTick: () => {},
      onActiveNotes: () => {},
      onStateChange: () => {},
      onLoadStateChange: (s) => seen.push(s),
    });

    await engine.initialize();
    expect(seen.at(-1)).toEqual({ status: 'ready' });
    // Fetching never claims the whole bar: seconds of decoding follow it, so a
    // completed download reads as half done, then goes indeterminate.
    const fractions = seen.filter((s) => s.status === 'loading').map((s) => s.fraction);
    expect(fractions).toEqual([0, 0.25, 0.5, null]);
  });

  it('reports a failure rather than going quiet', async () => {
    // A font that will not load is otherwise indistinguishable from silence.
    const context = suspendableContext();
    const engine = new SoundfontPlaybackEngine({
      host: stubHost(),
      moduleUrls: { fluidsynth: 'f.js', worklet: 'w.js' },
      fontUrl: 'font.sf3',
      loadFont: async () => {
        throw new Error('Soundfont fetch failed: 404');
      },
      createContext: () => context as never,
      now: () => 0,
      startPump: manualPump().start,
    });
    const seen: PlaybackLoadState[] = [];
    engine.setObserver({
      onPositionTick: () => {},
      onActiveNotes: () => {},
      onStateChange: () => {},
      onLoadStateChange: (s) => seen.push(s),
    });

    await expect(engine.initialize()).rejects.toThrow('404');
    expect(seen.at(-1)).toEqual({ status: 'failed', message: 'Soundfont fetch failed: 404' });
  });

  it('brings the synth up only once for concurrent callers', async () => {
    const { engine, host, score } = setup();
    await Promise.all([engine.initialize(), engine.initialize(), engine.loadScore(score)]);
    expect(host.init).toHaveBeenCalledTimes(1);
  });

  it('retries after a deferred attempt rather than caching it forever', async () => {
    const context = stubContext() as unknown as Record<string, unknown>;
    context.state = 'suspended';
    context.resume = vi.fn(async () => {});
    const { engine, host } = setup(undefined, () => context as never);
    await engine.initialize();
    expect(host.init).not.toHaveBeenCalled();

    context.resume = vi.fn(async () => {
      context.state = 'running';
    });
    await engine.initialize();
    expect(host.init).toHaveBeenCalled();
  });
});

describe('SoundfontPlaybackEngine: transport', () => {
  it('reports playing, then paused, then stopped', async () => {
    const { engine, score } = setup();
    const states: string[] = [];
    engine.setObserver({
      onPositionTick: () => {},
      onActiveNotes: () => {},
      onStateChange: (s) => states.push(s),
    });
    await engine.initialize();
    await engine.loadScore(score);
    await engine.play();
    engine.pause();
    engine.stop();
    expect(states).toEqual(['playing', 'paused', 'stopped']);
  });

  it('runs the pump only while playing', async () => {
    const { engine, pump, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);
    expect(pump.running).toBe(false);
    await engine.play();
    expect(pump.running).toBe(true);
    engine.pause();
    expect(pump.running).toBe(false);
  });

  it('dispatches notes that have come due, and does not repeat them', async () => {
    const { engine, host, pump, clock, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);
    await engine.play();

    clock.t = 1; // a second of score time has passed
    pump.step();
    const first = host.noteOn.mock.calls.length;
    expect(first).toBeGreaterThan(0);

    pump.step(); // same position: nothing new is due
    expect(host.noteOn.mock.calls.length).toBe(first);
  });

  it('starts the piece at its beginning even when the first pump tick is late', async () => {
    // Found by hand: the clock used to start in play(), but the first pump tick
    // can be seconds late while the main thread finishes worklet and soundfont
    // setup. By then the clock said the music was already seconds in, so every
    // note before that point was past its grace window and skipped — the
    // opening of the piece vanished. Measured at 2.3s lost on a real load.
    const { engine, host, pump, clock, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);
    await engine.play();

    clock.t = 2.3; // the thread was busy; the pump only runs now
    pump.step();

    // The opening notes must still sound, not be treated as long overdue.
    expect(host.noteOn).toHaveBeenCalled();
  });

  it('does not start the clock if playback is stopped before the pump ever runs', async () => {
    const { engine, host, pump, clock, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);
    await engine.play();
    engine.stop();

    clock.t = 5;
    pump.step(); // a stray tick must not resurrect playback
    expect(host.noteOn).not.toHaveBeenCalled();
  });

  it('clicks only when the metronome is on', async () => {
    const { engine, pump, clock, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);
    await engine.play();

    clock.t = 1;
    pump.step();
    const context = (engine as unknown as { context: AudioContext }).context;
    expect(vi.mocked(context.createOscillator)).not.toHaveBeenCalled();

    engine.setMetronome(true);
    clock.t = 2;
    pump.step();
    expect(vi.mocked(context.createOscillator)).toHaveBeenCalled();
  });

  it('silences everything on stop rather than leaving notes ringing', async () => {
    const { engine, host, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);
    await engine.play();
    host.allSoundOff.mockClear();
    engine.stop();
    expect(host.allSoundOff).toHaveBeenCalled();
  });

  it('reports the new position on seek, so the caret follows a click while stopped', async () => {
    // The caret is driven by the store's positionTick, and nothing else writes
    // it: `PlaybackController.seek` only forwards to the engine. Without this
    // report a click on the sheet moved the transport but left the caret at
    // tick 0, which is exactly how it looked.
    const { engine, score } = setup();
    const ticks: number[] = [];
    engine.setObserver({
      onPositionTick: (t) => ticks.push(t),
      onActiveNotes: () => {},
      onStateChange: () => {},
    });
    await engine.initialize();
    await engine.loadScore(score);

    engine.seek(score.ppq * 4);
    expect(ticks.at(-1)).toBe(score.ppq * 4);
  });

  it('keeps reporting after a backward seek during playback', async () => {
    // The throttle compares the incoming position against the last reported
    // one, so seeking backwards left the difference negative and suppressed
    // every report until playback caught back up — a caret that froze for as
    // long as the jump was.
    const { engine, pump, clock, score } = setup();
    const ticks: number[] = [];
    engine.setObserver({
      onPositionTick: (t) => ticks.push(t),
      onActiveNotes: () => {},
      onStateChange: () => {},
    });
    await engine.initialize();
    await engine.loadScore(score);
    await engine.play();

    clock.t = 60; // a minute into the piece
    pump.step();
    engine.seek(0); // jump back to the top — the audio clock keeps running

    ticks.length = 0;
    clock.t = 60.5;
    pump.step();
    expect(ticks.length).toBeGreaterThan(0);
  });

  it('seeking moves the queue cursor, so earlier notes do not fire afterwards', async () => {
    const { engine, host, pump, clock, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);
    await engine.play();

    engine.seek(score.ppq * 100); // far past every note
    clock.t = 0.1;
    pump.step();
    expect(host.noteOn).not.toHaveBeenCalled();
  });
});

describe('SoundfontPlaybackEngine: auditioning', () => {
  it('sounds a tapped key without touching transport state', async () => {
    const { engine, host, pump, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);

    engine.noteOn(60, 0);

    expect(host.noteOn).toHaveBeenCalled();
    expect(pump.running).toBe(false); // the transport stayed put
  });

  it('releases a held audition note', async () => {
    const { engine, host, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);
    engine.noteOn(60, 0);
    host.noteOff.mockClear();
    engine.noteOff(60);
    expect(host.noteOff).toHaveBeenCalled();
  });
});
