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
import { GM_INSTRUMENTS } from '@sudobility/music_lib';

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

  it('reads the pitched Percussive family correctly by program, where the name lies', () => {
    // GM 112-119 is the Percussive family: pitched instruments played on an
    // ordinary melodic channel. Three of them are named after drums, and the
    // name is what misled callers into handing them the unpitched kit — which
    // is why `tone-engine` resolves a track from its program and not its name.
    // Asserted as a pair so the trap itself stays documented rather than
    // looking like an arbitrary preference.
    for (const program of [114, 116, 118]) {
      expect(resolveInstrumentCategory(program, false)).toBe('percussive');
      expect(resolveInstrumentCategory(GM_INSTRUMENTS[program].name, false)).toBe('drum-kit');
    }
  });

  it('gives a driven guitar a sustaining voice, unlike a plucked one', () => {
    // Overdriven (29) and Distortion (30) sit in the GM guitar family but do
    // not behave like a plucked string: a driven amp keeps feeding the note.
    // On the plucked voice, whose sustain is 0, a two-second note died after
    // 0.56s, so held guitar lines played back chopped short.
    expect(resolveInstrumentCategory(29, false)).toBe('guitar-driven');
    expect(resolveInstrumentCategory(30, false)).toBe('guitar-driven');
    // Guitar Harmonics really does decay, and stays plucked.
    expect(resolveInstrumentCategory(31, false)).toBe('plucked');
    expect(resolveInstrumentCategory(24, false)).toBe('plucked');

    constructedInstances.length = 0;
    createInstrument(29, false);
    const [{ options }] = instancesOfType('PolySynth');
    const { envelope } = (options as { options: { envelope: { sustain: number } } }).options;
    expect(envelope.sustain).toBeGreaterThan(0.3);
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
    const trim = instancesOfType('Gain').at(-1)!.instance;
    const target = {} as Tone.ToneAudioNode;
    handle.connect(target);
    handle.dispose();
    // Every family now carries a calibration trim, so the voice reaches the
    // target through that node rather than connecting to it directly.
    expect(instance.connect).toHaveBeenCalledWith(trim);
    expect(trim.connect).toHaveBeenCalledWith(target);
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
  it('builds a PolySynth wrapping Synth whose attack still reads as bowed', () => {
    createInstrument('Strings', false);
    const [{ options }] = instancesOfType('PolySynth');
    const { voice, options: voiceOptions } = options as { voice: unknown; options: { envelope: { attack: number } } };
    expect(voice).toBe(Tone.Synth);
    // Slower than a struck voice, but shorter than the notes it is asked to
    // play: at 0.6s a quarter-note was released before the envelope had
    // reached full level, costing ~9dB on any ordinary passage.
    expect(voiceOptions.envelope.attack).toBeGreaterThan(0.1);
    expect(voiceOptions.envelope.attack).toBeLessThanOrEqual(0.3);
  });
});

describe('createInstrument: bass', () => {
  it('builds a PolySynth of MonoSynth voices for a bass GM program', () => {
    // This used to assert a bare MonoSynth, pinning the defect in place: one
    // voice meant a second simultaneous bass note threw inside Tone and was
    // never heard. The MonoSynth timbre is what bass wants; the single voice
    // was not.
    createInstrument(33, false); // Electric Bass (finger)
    expect(instancesOfType('MonoSynth')).toHaveLength(0);
    const [poly] = instancesOfType('PolySynth');
    expect((poly.options as { voice: { name: string } }).voice.name).toBe('MonoSynth');
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
    // The kit's own mixer Gain, plus the calibration trim every family carries.
    expect(instancesOfType('Gain')).toHaveLength(2);
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
    const [mixer, trim] = instancesOfType('Gain').map((g) => g.instance);
    const target = {} as Tone.ToneAudioNode;

    handle.connect(target);
    // Kit voices -> its own mixer -> the calibration trim -> the target.
    expect(mixer.connect).toHaveBeenCalledWith(trim);
    expect(trim.connect).toHaveBeenCalledWith(target);

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

describe('every pitched instrument is polyphonic', () => {
  // The bug this pins: the bass was a bare `Tone.MonoSynth`. A MonoSynth has
  // one voice, so a second note starting at the same tick — a chord, an octave
  // double, two parts landing together — made Tone throw "Start time must be
  // strictly greater than previous start time" and that note never sounded.
  // Checked across all 128 GM programs rather than for the bass alone, because
  // the defect is a whole class: any voice not wrapped in a PolySynth has it.
  //
  // `MembraneSynth` belongs on this list and was missing from it, which is how
  // the Percussive family (GM 112-119) shipped monophonic and went on throwing
  // the very error the list exists to catch. Any Tone voice extending
  // Monophonic goes here; the drum kit's own mono voices are exempt below
  // because they serialise colliding hits instead of dropping them.
  const MONOPHONIC = ['Synth', 'AMSynth', 'FMSynth', 'MonoSynth', 'MembraneSynth'];

  it('constructs no standalone monophonic voice for any GM program', () => {
    const offenders: string[] = [];
    for (let program = 0; program < 128; program++) {
      constructedInstances.length = 0;
      createInstrument(program, false);
      for (const type of MONOPHONIC) {
        if (instancesOfType(type).length > 0) {
          offenders.push(`program ${program} (${GM_INSTRUMENTS[program].name}) -> bare ${type}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('builds the pitched percussion voice polyphonically, keeping its struck timbre', () => {
    // GM 112-119 are pitched percussion played on a melodic channel: a synth
    // tom part routinely lands several notes at once, and a bare MembraneSynth
    // threw on every one after the first. The fix is polyphony, not a different
    // sound - it must still be a MembraneSynth underneath.
    constructedInstances.length = 0;
    createInstrument(118, false); // Synth Drum
    const [poly] = instancesOfType('PolySynth');
    expect(poly).toBeDefined();
    expect((poly.options as { voice: { name: string } }).voice.name).toBe('MembraneSynth');
  });

  it('builds the bass as a PolySynth of MonoSynth voices, keeping the timbre', () => {
    // Bass specifically, since that is what shipped broken: the fix must be
    // polyphony, not a switch to some other-sounding synth.
    constructedInstances.length = 0;
    createInstrument('Electric Bass', false);
    const [poly] = instancesOfType('PolySynth');
    expect(poly).toBeDefined();
    expect((poly.options as { voice: { name: string } }).voice.name).toBe('MonoSynth');
  });
});

describe('instrument output levels', () => {
  /** The linear gain of the trim node `createInstrument` inserted, or 1 when it inserted none. */
  function trimGain(nameOrProgram: string | number, isPercussion = false): number {
    constructedInstances.length = 0;
    createInstrument(nameOrProgram, isPercussion);
    const gains = instancesOfType('Gain');
    // The drum kit builds its own internal Gain(1) mixer; the trim is the last.
    const trim = gains.at(-1);
    return trim ? (trim.options as { value: number }).value : 1;
  }

  /** Measured raw level (dB) of each family, from the table in instruments.ts. */
  const MEASURED_RAW_DB: Record<string, number> = {
    Flute: -6.1, // pipe
    'Lead 1 (square)': -6.4, // synth-lead
    'Church Organ': -8.5, // organ
    Trumpet: -10.0, // brass
    Violin: -10.5, // strings
    'Acoustic Bass': -12.3, // bass
    'Pad 1 (new age)': -12.7, // synth-pad
    'String Ensemble 1': -15.1, // ensemble
  };
  const TARGET_DB = -14;
  const toDb = (gain: number): number => 20 * Math.log10(gain);

  it('lands every non-struck family on one common level, whatever its oscillators produce', () => {
    // The bug: nothing reconciled the families, so their raw output spanned
    // 24dB. A `pipe` patch (one sine) sat ~18dB above a `synth-pad` and ~24dB
    // above a hi-hat, which no per-track MIDI volume can compensate for — a
    // quiet family was simply inaudible beside a loud one, and arrangements
    // lost whole parts. Trims are now derived from measured RMS rather than
    // reasoned about, so this asserts the outcome, not the arithmetic.
    for (const [name, rawDb] of Object.entries(MEASURED_RAW_DB)) {
      expect(rawDb + toDb(trimGain(name))).toBeCloseTo(TARGET_DB, 1);
    }
  });

  it('holds struck voices at the peak ceiling instead, rather than exploding them', () => {
    // Piano, plucked, pitched percussion and the kit are a spike followed by a
    // decay: they peak as loud as a flute while carrying far less average
    // energy. Forcing their RMS up to a flute's would make them clip, so the
    // peak ceiling wins and they settle below target — correct, not a miss.
    const struck: Array<[string | number, number, boolean]> = [
      ['Acoustic Grand Piano', 0.781, false],
      ['Acoustic Guitar (nylon)', 0.781, false],
      [112, 0.791, false], // Tinkle Bell -> percussive
      [0, 0.999, true], // drum kit
    ];
    for (const [nameOrProgram, measuredPeak, isPercussion] of struck) {
      const peakAfterTrim = measuredPeak * trimGain(nameOrProgram, isPercussion);
      expect(peakAfterTrim).toBeLessThanOrEqual(0.9 + 1e-6);
      expect(peakAfterTrim).toBeCloseTo(0.9, 2);
    }
  });

  it('keeps the whole calibrated spread inside a musically sane range', () => {
    // A blanket guard: whatever the individual numbers, no family may end up
    // more than 8dB from another once trimmed. The defect being pinned was a
    // 24dB spread.
    const levels = Object.entries(MEASURED_RAW_DB).map(([name, rawDb]) => rawDb + toDb(trimGain(name)));
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(8);
  });

  it('covers every category, so a new family cannot ship untrimmed', () => {
    // The Record type enforces this at compile time; asserted here too because
    // a wrong *value* is silent, and every program must resolve to an entry.
    for (let program = 0; program < 128; program++) {
      expect(Number.isFinite(trimGain(program))).toBe(true);
    }
  });
});
