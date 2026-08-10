import { describe, expect, it, vi } from 'vitest';
import { twoTrackScore } from '@sudobility/music_lib';
import type { Score } from '@sudobility/music_types';
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

function setup(score?: Score) {
  const host = stubHost();
  const pump = manualPump();
  const clock = { t: 0 };
  const engine = new SoundfontPlaybackEngine({
    host,
    moduleUrls: { fluidsynth: 'f.js', worklet: 'w.js' },
    fontUrl: 'font.sf3',
    loadFont: async () => new Uint8Array(4).buffer,
    createContext: () => ({ sampleRate: 44100, close: vi.fn() }) as unknown as AudioContext,
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

  it('silences everything on stop rather than leaving notes ringing', async () => {
    const { engine, host, score } = setup();
    await engine.initialize();
    await engine.loadScore(score);
    await engine.play();
    host.allSoundOff.mockClear();
    engine.stop();
    expect(host.allSoundOff).toHaveBeenCalled();
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
