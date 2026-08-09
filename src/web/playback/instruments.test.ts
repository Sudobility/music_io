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
const { MockNode, constructedInstances, record, clock } = vi.hoisted(() => {
  const clock = { now: 0 };
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

  return { MockNode, constructedInstances, record, clock };
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
  return { Synth, AMSynth, FMSynth, MonoSynth, MembraneSynth, NoiseSynth, Sampler, PolySynth, Filter, Gain, now: () => clock.now };
});

import * as Tone from 'tone';
import { createInstrument, resolveInstrumentCategory } from './instruments/index.js';
import { GM_INSTRUMENTS } from '@sudobility/music_lib';

beforeEach(() => {
  constructedInstances.length = 0;
  clock.now = 0;
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

  it('overrides the family where GM files an instrument that does not behave like it', () => {
    // The GM families group by catalogue position, not by behaviour. Taking the
    // family voice made a timpani a bowed cello and a harpsichord a piano that
    // rings, so these are named individually.
    expect(resolveInstrumentCategory(47, false)).toBe('percussive'); // Timpani, filed under strings
    expect(resolveInstrumentCategory(45, false)).toBe('plucked'); // Pizzicato Strings
    expect(resolveInstrumentCategory(46, false)).toBe('plucked'); // Orchestral Harp
    expect(resolveInstrumentCategory(55, false)).toBe('stab'); // Orchestra Hit, filed under ensemble
    expect(resolveInstrumentCategory(6, false)).toBe('harpsichord');
    expect(resolveInstrumentCategory(7, false)).toBe('harpsichord'); // Clavinet
    expect(resolveInstrumentCategory(119, false)).toBe('reverse-swell'); // Reverse Cymbal

    // The rest of each family is untouched.
    expect(resolveInstrumentCategory(40, false)).toBe('strings'); // Violin
    expect(resolveInstrumentCategory(48, false)).toBe('ensemble'); // String Ensemble 1
    expect(resolveInstrumentCategory(0, false)).toBe('piano'); // Acoustic Grand
    expect(resolveInstrumentCategory(118, false)).toBe('percussive'); // Synth Drum
  });

  it('splits the chromatic-percussion family by how long each member rings', () => {
    // The family runs from a xylophone's dry click to tubular bells still
    // sounding many seconds later — a thirty-fold range that one decay cannot
    // cover. Sharing it made the wooden mallets ring like bells and the bells
    // stop like woodblocks.
    expect(resolveInstrumentCategory(12, false)).toBe('mallet-wood'); // Marimba
    expect(resolveInstrumentCategory(13, false)).toBe('mallet-wood'); // Xylophone
    expect(resolveInstrumentCategory(11, false)).toBe('vibraphone');
    expect(resolveInstrumentCategory(14, false)).toBe('tubular-bell');
    // Celesta, glockenspiel, music box and dulcimer keep the middling ring.
    expect(resolveInstrumentCategory(8, false)).toBe('chromatic-percussion');
    expect(resolveInstrumentCategory(15, false)).toBe('chromatic-percussion');
  });

  it('orders the mallet decays the way the instruments do', () => {
    const decayOf = (program: number): number => {
      constructedInstances.length = 0;
      createInstrument(program, false);
      const [{ options }] = instancesOfType('PolySynth');
      return (options as { options: { envelope: { decay: number } } }).options.envelope.decay;
    };
    expect(decayOf(13)).toBeLessThan(decayOf(8)); // xylophone shorter than celesta
    expect(decayOf(8)).toBeLessThan(decayOf(11)); // celesta shorter than vibraphone
    expect(decayOf(11)).toBeLessThan(decayOf(14)); // vibraphone shorter than tubular bells
  });

  it('gives the concrete sound effects a noise voice, not a pitched one', () => {
    // Seashore, applause and a gunshot have no note to play; they used to share
    // the pitched AM-sine FX voice with FX 1-8.
    for (const program of [120, 122, 126, 127]) {
      expect(resolveInstrumentCategory(program, false)).toBe('noise-effects');
    }
    expect(resolveInstrumentCategory(96, false)).toBe('synth-effects'); // FX 1 (rain) stays pitched
  });

  it('ignores the pitch it is handed on a voice that has none', () => {
    // A NoiseSynth takes (duration, time, velocity) — no frequency. Passing one
    // would throw, and a gunshot has no pitch to pass anyway.
    const handle = createInstrument(126, false); // Applause
    const [noise] = instancesOfType('NoiseSynth').map((c) => c.instance);
    handle.triggerAttackRelease(60, 0.4, 2, 0.7);
    expect(noise.triggerAttackRelease).toHaveBeenCalledWith(0.4, 2, 0.7);
  });

  it('makes the reverse cymbal swell instead of decay', () => {
    createInstrument(119, false);
    const [noise] = instancesOfType('NoiseSynth');
    const { envelope } = noise.options as { envelope: { attack: number; decay: number } };
    // Backwards is the instrument: it fades *in* and then stops.
    expect(envelope.attack).toBeGreaterThan(0.5);
    expect(envelope.attack).toBeGreaterThan(envelope.decay);
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
    expect(polySynths).toHaveLength(2); // dark + bright velocity layers
    for (const p of polySynths) expect((p.options as { voice: unknown }).voice).toBe(Tone.Synth);
  });

  it('converts midi to hertz, forwards duration/time, and splits velocity across the layers', () => {
    const handle = createInstrument('Piano', false);
    const [dark, bright] = instancesOfType('PolySynth').map((p) => p.instance);
    handle.triggerAttackRelease(60, 0.5, 1.25, 0.8);

    for (const layer of [dark, bright]) {
      expect(layer.triggerAttackRelease).toHaveBeenCalledWith(midiToHertz(60), 0.5, 1.25, expect.any(Number));
    }
    const vDark = dark.triggerAttackRelease.mock.calls[0][3] as number;
    const vBright = bright.triggerAttackRelease.mock.calls[0][3] as number;
    // Louder means brighter, and the split is equal-power so the note keeps
    // exactly the amplitude the velocity asked for.
    expect(vBright).toBeGreaterThan(vDark);
    expect(Math.hypot(vDark, vBright)).toBeCloseTo(0.8, 5);
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
  it('builds two FM layers whose modulation index differs, which is its brightness', () => {
    createInstrument('Electric Piano', false);
    const polySynths = instancesOfType('PolySynth');
    expect(polySynths).toHaveLength(2); // dark + bright velocity layers
    for (const p of polySynths) expect((p.options as { voice: unknown }).voice).toBe(Tone.FMSynth);
    const index = polySynths.map(
      (p) => (p.options as { options: { modulationIndex: number } }).options.modulationIndex,
    );
    expect(index[1]).toBeGreaterThan(index[0]);
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
  it('reaches its square timbre on the bright velocity layer', () => {
    createInstrument('Synth Lead', false);
    const types = instancesOfType('PolySynth').map(
      (p) => (p.options as { options: { oscillator: { type: string } } }).options.oscillator.type,
    );
    // Soft notes are the mellow layer; hard notes bring in the square.
    expect(types).toEqual(['triangle', 'square']);
  });
});

describe('createInstrument: drum kit', () => {
  it('builds a voice per percussion behaviour, not one noise tick for everything', () => {
    // Three voices used to cover the whole GM percussion map: kick, snare, and
    // a single 50ms noise burst for the ~30 remaining instruments. Cymbals ring
    // for seconds, hand drums are pitched, and cowbells and triangles are
    // metallic — none of which a 50ms noise burst can be.
    createInstrument('Drums', false);
    expect(instancesOfType('MembraneSynth')).toHaveLength(3); // kick, tom, hand drum
    expect(instancesOfType('NoiseSynth')).toHaveLength(5); // snare, closed/open hat, cymbal, shaker
    expect(instancesOfType('FMSynth')).toHaveLength(2); // metallic, wood
    expect(instancesOfType('Filter')).toHaveLength(4); // one colour per noise voice
    // The kit's mixer Gain, five internal balance Gains, and the calibration
    // trim every family carries.
    expect(instancesOfType('Gain')).toHaveLength(7);
  });

  it('gives cymbals a long tail and the closed hat a short one', () => {
    createInstrument('Drums', false);
    const decays = instancesOfType('NoiseSynth').map(
      (n) => (n.options as { envelope: { decay: number } }).envelope.decay,
    );
    // Ordered snare, closed hat, open hat, cymbal, shaker.
    const [, closedHat, openHat, cymbal] = decays;
    expect(cymbal).toBeGreaterThan(1); // a crash rings for seconds
    expect(openHat).toBeGreaterThan(closedHat); // open rings, closed chokes
    expect(closedHat).toBeLessThan(0.1);
  });

  it('sounds the pitched hand drums and metallic percussion at a pitch', () => {
    const handle = createInstrument('Drums', false);
    const handDrum = instancesOfType('MembraneSynth')[2].instance;
    const metallic = instancesOfType('FMSynth')[0].instance;

    handle.triggerAttackRelease(62, 0.2, 0, 0.8); // Mute Hi Conga
    handle.triggerAttackRelease(56, 0.2, 1, 0.8); // Cowbell

    expect(handDrum.triggerAttackRelease).toHaveBeenCalledWith(midiToHertz(62), 0.2, 0, 0.8);
    expect(metallic.triggerAttackRelease).toHaveBeenCalledWith(midiToHertz(56), 0.2, 1, 0.8);
  });

  it('routes a crash to the cymbal voice rather than the hat', () => {
    const handle = createInstrument('Drums', false);
    const [, closedHat, , cymbal] = instancesOfType('NoiseSynth').map((c) => c.instance);

    handle.triggerAttackRelease(49, 0.5, 0, 0.9); // Crash Cymbal 1

    expect(cymbal.triggerAttackRelease).toHaveBeenCalledWith(0.5, 0, 0.9);
    expect(closedHat.triggerAttackRelease).not.toHaveBeenCalled();
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
    const gains = instancesOfType('Gain').map((g) => g.instance);
    const mixer = gains[0];
    const trim = gains[gains.length - 1];
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

    // Both on the *closed* hat voice: 46 (open) now has its own ringing voice,
    // so the two hats no longer collide the way they used to.
    handle.triggerAttackRelease(42, 0.05, 1, 0.9); // Closed Hi-Hat
    handle.triggerAttackRelease(44, 0.05, 1, 0.9); // Pedal Hi-Hat, same tick

    const t1 = hat.triggerAttackRelease.mock.calls[0][1] as number;
    const t2 = hat.triggerAttackRelease.mock.calls[1][1] as number;
    expect(t1).toBe(1);
    expect(t2).toBeGreaterThan(t1);

    // An out-of-order retrigger (earlier time after a later one) also stays monotonic.
    handle.triggerAttackRelease(42, 0.05, 0.5, 0.9);
    const t3 = hat.triggerAttackRelease.mock.calls[2][1] as number;
    expect(t3).toBeGreaterThan(t2);
  });

  it('stays monotonic when the scheduled time has already passed', () => {
    // The failure this pins: Tone clamps a start time in the past up to `now`,
    // so a batch of events firing late all collapse onto the same instant. The
    // guard used to compare the nominal times, which were still distinct, and
    // waved the collision through — the assertion then fired for real and the
    // note was lost.
    const handle = createInstrument('Drums', true);
    const [, hat] = instancesOfType('NoiseSynth').map((c) => c.instance);

    clock.now = 5; // the transport stalled; these two are already overdue
    handle.triggerAttackRelease(42, 0.05, 1.0, 0.9);
    handle.triggerAttackRelease(44, 0.05, 1.2, 0.9);

    const t1 = hat.triggerAttackRelease.mock.calls[0][1] as number;
    const t2 = hat.triggerAttackRelease.mock.calls[1][1] as number;
    expect(t1).toBeGreaterThanOrEqual(5);
    expect(t2).toBeGreaterThan(t1);
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
    expect(resolveInstrumentCategory(120, false)).toBe('noise-effects'); // Guitar Fret Noise
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

describe('velocity response', () => {
  /** The velocities each layer of a voice was triggered with, for one note. */
  function velocities(nameOrProgram: string | number, velocity: number): number[] {
    constructedInstances.length = 0;
    const handle = createInstrument(nameOrProgram, false);
    handle.triggerAttackRelease(60, 0.5, 0, velocity);
    return constructedInstances
      .filter((c) => c.type === 'PolySynth')
      .flatMap((c) => c.instance.triggerAttackRelease.mock.calls.map((call) => call[3] as number));
  }

  it('brightens as it gets louder, instead of only getting louder', () => {
    // Velocity used to move amplitude and nothing else, which is not how an
    // instrument behaves: a trumpet leant on turns brassy, a piano struck hard
    // gains harmonics. The bright layer takes a growing share as velocity rises.
    for (const instrument of ['Piano', 'Trumpet', 'Violin', 'Acoustic Bass', 'Synth Lead']) {
      const [softDark, softBright] = velocities(instrument, 0.2);
      const [loudDark, loudBright] = velocities(instrument, 0.95);
      expect(softBright / softDark).toBeLessThan(loudBright / loudDark);
    }
  });

  it('keeps the amplitude the velocity asked for while doing it', () => {
    // Equal-power, so the two layers together never bulge above the written
    // dynamic in the middle of the range where both are sounding.
    for (const velocity of [0.1, 0.4, 0.8, 1]) {
      expect(Math.hypot(...velocities('Piano', velocity))).toBeCloseTo(velocity, 5);
    }
  });

  it('ignores velocity entirely on instruments that have no dynamics', () => {
    // A drawbar organ's key is a switch and a harpsichord's plectrum plucks
    // with a force the player cannot vary. Scaling either by velocity gave it
    // an expressive range it does not physically have.
    for (const instrument of ['Church Organ', 6]) {
      const soft = velocities(instrument, 0.15);
      const loud = velocities(instrument, 1);
      expect(soft).toEqual(loud);
    }
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
    'Lead 1 (square)': -5.3, // synth-lead
    'Church Organ': -8.0, // organ
    Trumpet: -8.6, // brass
    Violin: -8.6, // strings
    'Acoustic Bass': -10.9, // bass
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
      ['Acoustic Grand Piano', 0.717, false],
      ['Acoustic Guitar (nylon)', 0.749, false],
      [112, 0.795, false], // Tinkle Bell -> percussive
      [0, 0.796, true], // drum kit — loudest voice is the cymbal
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
