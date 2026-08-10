import { describe, expect, it, vi } from 'vitest';
import type { RenderPlan } from '@sudobility/music_types';
import { createSoundfontRenderer } from './soundfont-render.js';
import type { LoadedOfflineSynth } from './offline-synth.js';
import type { SynthesizerLike } from './synth-types.js';

const SAMPLE_RATE = 44100;

/**
 * A synth that records what it was told and writes a constant into the buffers,
 * so the render loop's own arithmetic can be checked.
 */
function stubSynth(fill: { left: number; right: number } = { left: 1, right: 1 }) {
  const calls: Record<string, unknown[][]> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
    };
  const synth: SynthesizerLike & { calls: typeof calls } = {
    calls,
    init: record('init'),
    loadSFont: vi.fn(async () => 1),
    render: (out: Float32Array[]) => {
      out[0].fill(fill.left);
      out[1].fill(fill.right);
    },
    midiNoteOn: record('midiNoteOn'),
    midiNoteOff: record('midiNoteOff'),
    midiControl: record('midiControl'),
    midiProgramSelect: record('midiProgramSelect'),
    midiSetChannelType: record('midiSetChannelType'),
    midiAllSoundsOff: record('midiAllSoundsOff'),
    close: record('close'),
  };
  return synth;
}

function rendererFor(synth: SynthesizerLike, onAcquire?: () => void) {
  const loaded: LoadedOfflineSynth = { synth, sfontId: 1, sampleRate: SAMPLE_RATE };
  return createSoundfontRenderer({
    fluidsynthModuleUrl: 'f.js',
    fontUrl: 'font.sf3',
    loadFont: async () => new Uint8Array(4).buffer,
    acquireSynth: async () => {
      onAcquire?.();
      return loaded;
    },
  });
}

const track = (over: Partial<RenderPlan['tracks'][number]> = {}) => ({
  id: 't1',
  midiProgram: 40,
  instrumentName: 'Violin',
  isPercussion: false,
  volume: 1,
  pan: 0,
  ...over,
});

const plan = (over: Partial<RenderPlan> = {}): RenderPlan => ({
  tracks: [track()],
  events: [{ trackId: 't1', midi: 60, startSec: 0.5, durationSec: 0.25, velocity: 0.8 }],
  durationSec: 1,
  ...over,
});

describe('createSoundfontRenderer', () => {
  it('renders audio of the planned length plus a release tail', async () => {
    const synth = stubSynth();
    const audio = await rendererFor(synth)(plan());
    expect(audio.sampleRate).toBe(SAMPLE_RATE);
    expect(audio.samples.length).toBe(Math.ceil(2 * SAMPLE_RATE)); // 1s + 1s tail
  });

  it('mixes both channels down, so a hard-panned track does not vanish', async () => {
    // The old renderer took channel 0 only. A track panned fully right was
    // audible in playback and silent in the export.
    const audio = await rendererFor(stubSynth({ left: 0, right: 1 }))(plan());
    expect(audio.samples[0]).toBeCloseTo(0.5, 6);
  });

  it('never selects a program on a percussion track', async () => {
    // Selecting one silences the channel — measured in the spike.
    const synth = stubSynth();
    await rendererFor(synth)(plan({ tracks: [track({ isPercussion: true })], events: [] }));
    expect(synth.calls.midiProgramSelect).toBeUndefined();
  });

  it('selects the GM program for a pitched track', async () => {
    const synth = stubSynth();
    await rendererFor(synth)(plan({ events: [] }));
    expect(synth.calls.midiProgramSelect?.[0]).toEqual([0, 1, 0, 40]);
  });

  it('sends volume and pan as CC7 and CC10', async () => {
    const synth = stubSynth();
    await rendererFor(synth)(plan({ tracks: [track({ volume: 0.5, pan: -1 })], events: [] }));
    const controls = synth.calls.midiControl ?? [];
    expect(controls).toContainEqual([0, 7, 64]);
    expect(controls).toContainEqual([0, 10, 0]);
  });

  it('places a note in the block it falls due, not at the start', async () => {
    // The whole point of the chunked loop. If events were dispatched up front
    // every note would sound at zero, which is what the spike did.
    const synth = stubSynth();
    let framesRenderedBeforeNoteOn = 0;
    let blocks = 0;
    const original = synth.render;
    synth.render = (out) => {
      blocks += 1;
      original(out);
    };
    synth.midiNoteOn = () => {
      framesRenderedBeforeNoteOn = blocks * 128;
    };
    await rendererFor(synth)(plan());
    // The note starts at 0.5s = 22050 frames; allow one block of slack.
    expect(framesRenderedBeforeNoteOn).toBeGreaterThan(22050 - 256);
    expect(framesRenderedBeforeNoteOn).toBeLessThan(22050 + 256);
  });

  it('silences the shared synth before and after each render', async () => {
    // It is reused across exports, so it starts dirty and must not leak notes
    // into the next one.
    const synth = stubSynth();
    await rendererFor(synth)(plan({ events: [] }));
    expect(synth.calls.midiAllSoundsOff?.length).toBe(2);
  });

  it('reuses the synth across renders rather than reloading the soundfont', async () => {
    // The reason this rewrite exists: the previous design built a fresh
    // worklet and reloaded a 23MB font on every single export.
    const synth = stubSynth();
    let acquisitions = 0;
    const render = rendererFor(synth, () => {
      acquisitions += 1;
    });
    await render(plan({ events: [] }));
    await render(plan({ events: [] }));
    expect(acquisitions).toBe(2); // acquire is memoised inside getOfflineSynth
    expect(synth.calls.init).toBeUndefined(); // never re-initialised here
    expect(vi.mocked(synth.loadSFont)).not.toHaveBeenCalled();
  });
});
