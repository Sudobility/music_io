import { describe, expect, it, vi } from 'vitest';
import { SynthHost } from './synth-host.js';
import type { SynthInstance } from './synth-host.js';

/** A stand-in for one `AudioWorkletNodeSynthesizer`, recording what it was told. */
function stubSynth(): SynthInstance & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
    };
  return {
    calls,
    init: record('init'),
    createAudioNode: vi.fn(() => ({ connect: vi.fn() }) as unknown as AudioNode),
    loadSFont: vi.fn(async () => 1),
    midiNoteOn: record('midiNoteOn'),
    midiNoteOff: record('midiNoteOff'),
    midiProgramSelect: record('midiProgramSelect'),
    midiControl: record('midiControl'),
    midiSetChannelType: record('midiSetChannelType'),
    midiAllSoundsOff: record('midiAllSoundsOff'),
    setInterpolation: record('setInterpolation'),
    close: record('close'),
  };
}

/** A minimal AudioContext surface: enough for the master chain and nothing more. */
function stubContext() {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  return {
    sampleRate: 44100,
    currentTime: 0,
    destination: node(),
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createGain: vi.fn(() => ({ ...node(), gain: { value: 1 } })),
    createDynamicsCompressor: vi.fn(() => ({
      ...node(),
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
    })),
  } as unknown as AudioContext;
}

async function hostWith(instanceCount: number) {
  const synths = Array.from({ length: instanceCount }, () => stubSynth());
  let made = 0;
  const host = new SynthHost({ createSynth: () => synths[made++] });
  await host.init(stubContext(), {
    fluidsynthModuleUrl: 'fluid.js',
    workletModuleUrl: 'worklet.js',
    soundfont: new Uint8Array(4).buffer,
    instanceCount,
  });
  return { host, synths };
}

describe('SynthHost', () => {
  it('loads the quiet-module seed, then fluidsynth, then the worklet', async () => {
    // Order is the whole contract here. The seed must precede libfluidsynth so
    // its emscripten module adopts a printErr that drops build-stub notices,
    // and libfluidsynth must precede the worklet build, which expects it.
    const ctx = stubContext();
    const host = new SynthHost({ createSynth: () => stubSynth() });
    await host.init(ctx, {
      fluidsynthModuleUrl: 'fluid.js',
      workletModuleUrl: 'worklet.js',
      soundfont: new Uint8Array(4).buffer,
      instanceCount: 1,
    });
    const added = vi.mocked(ctx.audioWorklet.addModule).mock.calls.map((c) => String(c[0]));
    expect(added).toHaveLength(3);
    expect(added[0]).toMatch(/^blob:/); // the quiet-module seed
    expect(added.slice(1)).toEqual(['fluid.js', 'worklet.js']);
  });

  it('never selects a program on a percussion channel', async () => {
    // The spike measured this: selecting a program on channel 9 replaces
    // fluidsynth's working default with a preset that is not there, and the
    // channel goes silent. Guarding it here is the whole reason drums work.
    const { host, synths } = await hostWith(1);
    host.setChannelPercussion(0, 9);
    host.programSelect(0, 9, 42);
    expect(synths[0].calls.midiProgramSelect).toBeUndefined();
  });

  it('does select a program on an ordinary channel', async () => {
    const { host, synths } = await hostWith(1);
    host.programSelect(0, 3, 42);
    expect(synths[0].calls.midiProgramSelect?.[0]).toEqual([3, 1, 0, 42]);
  });

  it('marks a non-nine percussion channel as a drum channel', async () => {
    // How a second drum track shares an instance instead of costing another.
    const { host, synths } = await hostWith(1);
    host.setChannelPercussion(0, 5);
    expect(synths[0].calls.midiSetChannelType?.[0]).toEqual([5, true]);
  });

  it('routes notes to the instance that owns the channel', async () => {
    const { host, synths } = await hostWith(2);
    host.noteOn(1, 4, 60, 100);
    expect(synths[0].calls.midiNoteOn).toBeUndefined();
    expect(synths[1].calls.midiNoteOn?.[0]).toEqual([4, 60, 100]);
  });

  it('applies interpolation to every instance, since the governor speaks for all of them', async () => {
    const { host, synths } = await hostWith(2);
    host.setInterpolation(4);
    for (const s of synths) expect(s.calls.setInterpolation?.at(-1)).toEqual([4]);
  });

  it('silences every instance on allSoundOff', async () => {
    const { host, synths } = await hostWith(2);
    host.allSoundOff();
    for (const s of synths) expect(s.calls.midiAllSoundsOff).toBeDefined();
  });

  it('ignores calls for an instance that does not exist rather than throwing', async () => {
    // A stale channel assignment must not take down the audio thread.
    const { host } = await hostWith(1);
    expect(() => host.noteOn(5, 0, 60, 100)).not.toThrow();
  });
});
