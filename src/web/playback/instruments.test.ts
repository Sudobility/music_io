import { describe, expect, it, vi, beforeEach } from 'vitest';
import { midiToHertz } from './midi.js';

// A minimal mock of the `tone` module: every mocked class just records its
// constructor call (type + options) and exposes triggerAttackRelease/
// connect/dispose as spies, matching the tiny surface instruments.ts
// actually calls. No AudioContext, no real audio graph — this is exactly
// the small mocked-Tone surface the Task 13 brief asks for.
// `vi.mock` factories are hoisted above the rest of the module, so any
// state/helpers they close over must be created via `vi.hoisted` (plain
// top-level `const`s would be accessed before initialization).
const { MockNode, constructedInstances, record } = vi.hoisted(() => {
  class MockNode {
    triggerAttackRelease = vi.fn();
    connect = vi.fn();
    dispose = vi.fn();
  }

  type ConstructedInstance = { type: string; options: unknown; instance: InstanceType<typeof MockNode> };
  const constructedInstances: ConstructedInstance[] = [];

  function record(type: string, options: unknown, instance: InstanceType<typeof MockNode>): void {
    constructedInstances.push({ type, options, instance });
  }

  return { MockNode, constructedInstances, record };
});

vi.mock('tone', () => {
  class Synth extends MockNode {
    constructor(public options?: unknown) {
      super();
      record('Synth', options, this);
    }
  }
  class AMSynth extends MockNode {
    constructor(options?: unknown) {
      super();
      record('AMSynth', options, this);
    }
  }
  class FMSynth extends MockNode {
    constructor(public options?: unknown) {
      super();
      record('FMSynth', options, this);
    }
  }
  class MonoSynth extends MockNode {
    constructor(public options?: unknown) {
      super();
      record('MonoSynth', options, this);
    }
  }
  class MembraneSynth extends MockNode {
    constructor(public options?: unknown) {
      super();
      record('MembraneSynth', options, this);
    }
  }
  class NoiseSynth extends MockNode {
    constructor(public options?: unknown) {
      super();
      record('NoiseSynth', options, this);
    }
  }
  class Sampler extends MockNode {
    constructor(public options?: unknown) {
      super();
      record('Sampler', options, this);
    }
  }
  class PolySynth extends MockNode {
    constructor(
      public voice?: unknown,
      public options?: unknown,
    ) {
      super();
      record('PolySynth', { voice, options }, this);
    }
  }
  class Filter extends MockNode {
    constructor(
      public frequency?: unknown,
      public filterType?: unknown,
    ) {
      super();
      record('Filter', { frequency, filterType }, this);
    }
  }
  class Gain extends MockNode {
    constructor(public value?: unknown) {
      super();
      record('Gain', { value }, this);
    }
  }
  return { Synth, AMSynth, FMSynth, MonoSynth, MembraneSynth, NoiseSynth, Sampler, PolySynth, Filter, Gain };
});

import * as Tone from 'tone';
import { createInstrument, resolveInstrumentCategory } from './instruments.js';
import { GM_INSTRUMENTS } from '../../domain/instruments/gm.js';

beforeEach(() => {
  constructedInstances.length = 0;
});

function instancesOfType(type: string) {
  return constructedInstances.filter((c) => c.type === type);
}

describe('resolveInstrumentCategory', () => {
  it('is always drum-kit when isPercussion, regardless of name/program', () => {
    expect(resolveInstrumentCategory('Anything', true)).toBe('drum-kit');
    expect(resolveInstrumentCategory(0, true)).toBe('drum-kit');
  });

  it('resolves by name keyword', () => {
    expect(resolveInstrumentCategory('Piano', false)).toBe('piano');
    expect(resolveInstrumentCategory('Electric Piano', false)).toBe('electric-piano');
    expect(resolveInstrumentCategory('Rhodes', false)).toBe('electric-piano');
    // GM puts "String Ensemble" in the Ensemble family, which now has its own
    // voice; it only read as plain 'strings' while that voice didn't exist.
    expect(resolveInstrumentCategory('String Ensemble', false)).toBe('ensemble');
    expect(resolveInstrumentCategory('Violin', false)).toBe('strings');
    expect(resolveInstrumentCategory('Acoustic Bass', false)).toBe('bass');
    expect(resolveInstrumentCategory('Synth Lead', false)).toBe('synth-lead');
    expect(resolveInstrumentCategory('Drum Kit', false)).toBe('drum-kit');
  });

  it('defaults an unrecognized name to piano', () => {
    expect(resolveInstrumentCategory('Kazoo', false)).toBe('piano');
  });

  it('resolves by GM program number range', () => {
    expect(resolveInstrumentCategory(0, false)).toBe('piano'); // Acoustic Grand Piano
    expect(resolveInstrumentCategory(4, false)).toBe('electric-piano'); // Electric Piano 1
    expect(resolveInstrumentCategory(5, false)).toBe('electric-piano'); // Electric Piano 2
    expect(resolveInstrumentCategory(33, false)).toBe('bass'); // Electric Bass
    expect(resolveInstrumentCategory(48, false)).toBe('ensemble'); // String Ensemble 1
    expect(resolveInstrumentCategory(40, false)).toBe('strings'); // Violin
    expect(resolveInstrumentCategory(81, false)).toBe('synth-lead'); // Lead 2 (sawtooth)
  });

});

describe('createInstrument: piano', () => {
  it('uses the synth fallback (no bundled sample urls) rather than Sampler', () => {
    createInstrument('Piano', false);
    expect(instancesOfType('Sampler')).toHaveLength(0);
    const polySynths = instancesOfType('PolySynth');
    expect(polySynths).toHaveLength(1);
    expect((polySynths[0].options as { voice: unknown }).voice).toBe(Tone.Synth);
  });

  it('triggerAttackRelease converts midi to hertz and forwards duration/time/velocity', () => {
    const handle = createInstrument('Piano', false);
    const [{ instance }] = instancesOfType('PolySynth');
    handle.triggerAttackRelease(60, 0.5, 1.25, 0.8);
    expect(instance.triggerAttackRelease).toHaveBeenCalledWith(midiToHertz(60), 0.5, 1.25, 0.8);
  });

  it('connect and dispose delegate to the underlying voice', () => {
    const handle = createInstrument('Piano', false);
    const [{ instance }] = instancesOfType('PolySynth');
    const target = {} as Tone.ToneAudioNode;
    handle.connect(target);
    handle.dispose();
    expect(instance.connect).toHaveBeenCalledWith(target);
    expect(instance.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('createInstrument: electric piano', () => {
  it('builds a PolySynth wrapping FMSynth', () => {
    createInstrument('Electric Piano', false);
    const polySynths = instancesOfType('PolySynth');
    expect(polySynths).toHaveLength(1);
    expect((polySynths[0].options as { voice: unknown }).voice).toBe(Tone.FMSynth);
  });
});

describe('createInstrument: strings', () => {
  it('builds a slow-attack PolySynth wrapping Synth', () => {
    createInstrument('Strings', false);
    const [{ options }] = instancesOfType('PolySynth');
    const { voice, options: voiceOptions } = options as { voice: unknown; options: { envelope: { attack: number } } };
    expect(voice).toBe(Tone.Synth);
    expect(voiceOptions.envelope.attack).toBeGreaterThan(0.3);
  });
});

describe('createInstrument: bass', () => {
  it('builds a MonoSynth for a bass GM program', () => {
    createInstrument(33, false); // Electric Bass (finger)
    expect(instancesOfType('MonoSynth')).toHaveLength(1);
  });
});

describe('createInstrument: synth lead', () => {
  it('builds a PolySynth wrapping Synth with a square oscillator', () => {
    createInstrument('Synth Lead', false);
    const [{ options }] = instancesOfType('PolySynth');
    const { voice, options: voiceOptions } = options as {
      voice: unknown;
      options: { oscillator: { type: string } };
    };
    expect(voice).toBe(Tone.Synth);
    expect(voiceOptions.oscillator.type).toBe('square');
  });
});

describe('createInstrument: drum kit', () => {
  it('builds one MembraneSynth (kick) and two NoiseSynths (snare, hat) behind a Gain output', () => {
    createInstrument('Drums', false);
    expect(instancesOfType('MembraneSynth')).toHaveLength(1);
    expect(instancesOfType('NoiseSynth')).toHaveLength(2);
    expect(instancesOfType('Filter')).toHaveLength(1);
    expect(instancesOfType('Gain')).toHaveLength(1);
  });

  it('routes GM kick notes to the MembraneSynth', () => {
    const handle = createInstrument('Drums', false);
    const kick = instancesOfType('MembraneSynth')[0].instance;
    const [snare, hat] = instancesOfType('NoiseSynth').map((c) => c.instance);

    handle.triggerAttackRelease(36, 0.1, 0, 0.9); // Bass Drum 1

    expect(kick.triggerAttackRelease).toHaveBeenCalledWith(midiToHertz(36), 0.1, 0, 0.9);
    expect(snare.triggerAttackRelease).not.toHaveBeenCalled();
    expect(hat.triggerAttackRelease).not.toHaveBeenCalled();
  });

  it('routes GM snare notes to the first NoiseSynth, with the noise-instrument (duration/time/velocity) signature', () => {
    const handle = createInstrument('Drums', true);
    const kick = instancesOfType('MembraneSynth')[0].instance;
    const [snare, hat] = instancesOfType('NoiseSynth').map((c) => c.instance);

    handle.triggerAttackRelease(38, 0.15, 2, 0.7); // Acoustic Snare

    expect(snare.triggerAttackRelease).toHaveBeenCalledWith(0.15, 2, 0.7);
    expect(kick.triggerAttackRelease).not.toHaveBeenCalled();
    expect(hat.triggerAttackRelease).not.toHaveBeenCalled();
  });

  it('routes any other GM percussion note (e.g. hi-hat) to the second NoiseSynth', () => {
    const handle = createInstrument('Drums', true);
    const [snare, hat] = instancesOfType('NoiseSynth').map((c) => c.instance);

    handle.triggerAttackRelease(42, 0.05, 1, 0.5); // Closed Hi-Hat

    expect(hat.triggerAttackRelease).toHaveBeenCalledWith(0.05, 1, 0.5);
    expect(snare.triggerAttackRelease).not.toHaveBeenCalled();
  });

  it('connect wires the shared Gain output; dispose tears down every internal node', () => {
    const handle = createInstrument('Drums', true);
    const gain = instancesOfType('Gain')[0].instance;
    const target = {} as Tone.ToneAudioNode;

    handle.connect(target);
    expect(gain.connect).toHaveBeenCalledWith(target);

    handle.dispose();
    for (const type of ['MembraneSynth', 'NoiseSynth', 'Filter', 'Gain']) {
      for (const { instance } of instancesOfType(type)) {
        expect(instance.dispose).toHaveBeenCalledTimes(1);
      }
    }
  });
});

describe('createInstrument: drum kit mono-voice retrigger guard', () => {
  it('nudges same-time hits on one voice to strictly increasing times (Tone Noise.start requirement)', () => {
    const handle = createInstrument('Drums', true);
    const [, hat] = instancesOfType('NoiseSynth').map((c) => c.instance);

    handle.triggerAttackRelease(42, 0.05, 1, 0.9); // Closed Hi-Hat
    handle.triggerAttackRelease(46, 0.05, 1, 0.9); // Open Hi-Hat, same tick

    const t1 = hat.triggerAttackRelease.mock.calls[0][1] as number;
    const t2 = hat.triggerAttackRelease.mock.calls[1][1] as number;
    expect(t1).toBe(1);
    expect(t2).toBeGreaterThan(t1);

    // An out-of-order retrigger (earlier time after a later one) also stays monotonic.
    handle.triggerAttackRelease(42, 0.05, 0.5, 0.9);
    const t3 = hat.triggerAttackRelease.mock.calls[2][1] as number;
    expect(t3).toBeGreaterThan(t2);
  });

  it('keeps distinct voices independent: a kick at the same time as a hat is not nudged', () => {
    const handle = createInstrument('Drums', true);
    const kick = instancesOfType('MembraneSynth')[0].instance;

    handle.triggerAttackRelease(42, 0.05, 3, 0.9); // hat at t=3
    handle.triggerAttackRelease(36, 0.1, 3, 0.9); // kick at the same t=3

    expect(kick.triggerAttackRelease.mock.calls[0][2]).toBe(3);
  });
});

describe('categoryForProgram covers every GM family', () => {
  it('never falls back to piano for a non-piano family', () => {
    // The regression this guards: 122 of 128 programs used to resolve to
    // 'piano', so picking Trumpet played a piano.
    const pianoFamilyPrograms = new Set(
      GM_INSTRUMENTS.filter((i) => i.family === 'piano').map((i) => i.program),
    );
    for (const instrument of GM_INSTRUMENTS) {
      const category = resolveInstrumentCategory(instrument.program, false);
      if (!pianoFamilyPrograms.has(instrument.program)) {
        expect(category, `program ${instrument.program} (${instrument.name})`).not.toBe('piano');
      }
    }
  });

  it('resolves a category for all 128 programs', () => {
    for (const instrument of GM_INSTRUMENTS) {
      expect(resolveInstrumentCategory(instrument.program, false)).toBeTruthy();
    }
  });

  it('still lets a percussion clef win over any program', () => {
    expect(resolveInstrumentCategory(0, true)).toBe('drum-kit');
    expect(resolveInstrumentCategory(56, true)).toBe('drum-kit');
  });

  it('falls back for a program outside the GM range rather than throwing', () => {
    expect(() => resolveInstrumentCategory(999, false)).not.toThrow();
    expect(resolveInstrumentCategory(999, false)).toBe('piano');
  });
});

describe('per-family synth voices', () => {
  it('gives the wind and keyboard families genuinely different voices', () => {
    // The point of the exercise: these all used to collapse onto 'piano', and
    // then onto a shared "nearest of six". They must now be distinct.
    const categories = [16, 24, 40, 48, 56, 64, 72, 88, 112].map((program) =>
      resolveInstrumentCategory(program, false),
    );
    expect(new Set(categories).size).toBe(categories.length);
  });

  it('maps each family to its own voice', () => {
    expect(resolveInstrumentCategory(0, false)).toBe('piano'); // Acoustic Grand
    expect(resolveInstrumentCategory(8, false)).toBe('chromatic-percussion'); // Celesta
    expect(resolveInstrumentCategory(16, false)).toBe('organ'); // Drawbar Organ
    expect(resolveInstrumentCategory(24, false)).toBe('plucked'); // Acoustic Guitar
    expect(resolveInstrumentCategory(32, false)).toBe('bass'); // Acoustic Bass
    expect(resolveInstrumentCategory(40, false)).toBe('strings'); // Violin
    expect(resolveInstrumentCategory(48, false)).toBe('ensemble'); // String Ensemble 1
    expect(resolveInstrumentCategory(56, false)).toBe('brass'); // Trumpet
    expect(resolveInstrumentCategory(64, false)).toBe('reed'); // Soprano Sax
    expect(resolveInstrumentCategory(72, false)).toBe('pipe'); // Piccolo
    expect(resolveInstrumentCategory(80, false)).toBe('synth-lead'); // Lead 1
    expect(resolveInstrumentCategory(88, false)).toBe('synth-pad'); // Pad 1
    expect(resolveInstrumentCategory(96, false)).toBe('synth-effects'); // FX 1
    expect(resolveInstrumentCategory(104, false)).toBe('plucked'); // Sitar
    expect(resolveInstrumentCategory(112, false)).toBe('percussive'); // Tinkle Bell
    expect(resolveInstrumentCategory(120, false)).toBe('synth-effects'); // Guitar Fret Noise
  });

  it('keeps electric piano distinct from acoustic within the piano family', () => {
    expect(resolveInstrumentCategory(4, false)).toBe('electric-piano');
    expect(resolveInstrumentCategory(0, false)).toBe('piano');
  });

  it('builds a usable instrument for every one of the 128 programs', () => {
    for (const instrument of GM_INSTRUMENTS) {
      const handle = createInstrument(instrument.program, false);
      expect(typeof handle.triggerAttackRelease, `program ${instrument.program}`).toBe('function');
      expect(typeof handle.connect).toBe('function');
      expect(typeof handle.dispose).toBe('function');
      handle.dispose();
    }
  });

  it('resolves the new voices from a free-text name too', () => {
    // Tracks imported from MIDI/MusicXML can carry a name and no useful program.
    expect(resolveInstrumentCategory('Church Organ', false)).toBe('organ');
    expect(resolveInstrumentCategory('Acoustic Guitar', false)).toBe('plucked');
    expect(resolveInstrumentCategory('Trumpet', false)).toBe('brass');
    expect(resolveInstrumentCategory('Alto Sax', false)).toBe('reed');
    expect(resolveInstrumentCategory('Flute', false)).toBe('pipe');
    expect(resolveInstrumentCategory('Warm Pad', false)).toBe('synth-pad');
  });

  it('still lets a percussion clef win over any program', () => {
    expect(resolveInstrumentCategory(56, true)).toBe('drum-kit');
  });
});
