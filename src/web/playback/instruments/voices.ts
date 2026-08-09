/**
 * What each family actually sounds like, as one table.
 *
 * These are synthesized approximations, not samples: the oscillator and
 * envelope carry the family's character — struck vs plucked vs bowed vs blown —
 * which is what makes a brass line read as brass beside a flute line. Real
 * fidelity needs a sample library, which `handle.ts` is already shaped for.
 *
 * Written as data rather than twenty near-identical factory functions so the
 * families can be *compared*: whether a marimba decays faster than a celesta,
 * or which voices answer velocity with timbre, is the kind of question this
 * file exists to answer at a glance. Anything that cannot be expressed as a
 * synth spec — the drum kit, the noise voices, the piano's sampler fallback —
 * says so explicitly with `custom`.
 */
import * as Tone from 'tone';
import { wrapVoice } from './handle.js';
import type { InstrumentHandle } from './handle.js';
import { withFixedVelocity, withVelocityTimbre, FIXED_VELOCITY } from './velocity.js';
import { createDrumKitInstrument } from './drum-kit.js';
import { monotonicTime } from './handle.js';
import type { InstrumentCategory } from './categories.js';

/** The Tone voice classes this table builds `PolySynth`s from. */
type VoiceClass =
  | typeof Tone.Synth
  | typeof Tone.FMSynth
  | typeof Tone.AMSynth
  | typeof Tone.MonoSynth
  | typeof Tone.MembraneSynth;

/** One `new Tone.PolySynth(voice, options)` call, as data. */
type SynthSpec = { voice: VoiceClass; options: Record<string, unknown> };

/**
 * How a family is built.
 *
 * `layers` is the velocity-timbre pair (see `velocity.ts`): the dark layer
 * carries soft notes, the bright one takes over as velocity rises. `fixed` is
 * for instruments with no dynamics at all.
 */
type VoiceSpec =
  | { kind: 'single'; synth: SynthSpec }
  | { kind: 'layers'; dark: SynthSpec; bright: SynthSpec }
  | { kind: 'fixed'; synth: SynthSpec }
  | { kind: 'custom'; build: () => InstrumentHandle };

/** A pair of layers differing only in oscillator: the common velocity-timbre shape. */
function oscillatorLayers(envelope: object, dark: string, bright: string): VoiceSpec {
  return {
    kind: 'layers',
    dark: { voice: Tone.Synth, options: { oscillator: { type: dark }, envelope } },
    bright: { voice: Tone.Synth, options: { oscillator: { type: bright }, envelope } },
  };
}

/**
 * A struck metal or wooden bar: FM sine, inharmonic, ringing for `decay`
 * seconds. Every number is passed in rather than derived — these voices are
 * calibrated against their measured output, so a value cannot be inferred from
 * another without invalidating the row in `calibration.ts`.
 */
type MalletSpec = {
  /** How inharmonic: higher reads as more bell-like, lower as wood. */
  harmonicity: number;
  modulationIndex: number;
  attack: number;
  decay: number;
  release: number;
  /** The modulator's own decay — how fast the strike's brightness fades. */
  modDecay: number;
};

function malletSpec({ harmonicity, modulationIndex, attack, decay, release, modDecay }: MalletSpec): SynthSpec {
  return {
    voice: Tone.FMSynth,
    options: {
      harmonicity,
      modulationIndex,
      oscillator: { type: 'sine' },
      envelope: { attack, decay, sustain: 0, release },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack, decay: modDecay, sustain: 0, release: modDecay },
    },
  };
}

/** A noise burst that ignores the pitch it is handed, because its instrument has none. */
function noiseVoice(options: ConstructorParameters<typeof Tone.NoiseSynth>[0]): InstrumentHandle {
  const noise = new Tone.NoiseSynth(options);
  const nudge = monotonicTime();
  return {
    triggerAttackRelease(_midi, durationSeconds, time, velocity) {
      noise.triggerAttackRelease(durationSeconds, nudge(time), velocity);
    },
    connect(node) {
      noise.connect(node);
    },
    dispose() {
      noise.dispose();
    },
  };
}

/** See the module doc in `handle.ts`: empty today (no bundled samples), by design. */
const PIANO_SAMPLE_URLS: Record<string, string> = {};

const PIANO_ENVELOPE = { attack: 0.005, decay: 0.35, sustain: 0.15, release: 0.6 };

function createPianoInstrument(): InstrumentHandle {
  const fallback = (): Tone.PolySynth<Tone.Synth> =>
    new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'triangle' }, envelope: PIANO_ENVELOPE });
  if (Object.keys(PIANO_SAMPLE_URLS).length === 0) {
    return withVelocityTimbre(
      wrapVoice(fallback()),
      // A hard-struck piano gains harmonics a soft touch never makes.
      wrapVoice(
        new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'sawtooth' },
          envelope: { ...PIANO_ENVELOPE, attack: 0.004 },
        }),
      ),
    );
  }
  try {
    return wrapVoice(new Tone.Sampler({ urls: PIANO_SAMPLE_URLS }));
  } catch {
    return wrapVoice(fallback());
  }
}

/** Rhodes/Wurlitzer FM, at a given brightness — modulation index *is* brightness on an FM voice. */
function electricPiano(modulationIndex: number): SynthSpec {
  return {
    voice: Tone.FMSynth,
    options: {
      harmonicity: 3.01,
      modulationIndex,
      envelope: { attack: 0.001, decay: 1.2, sustain: 0.1, release: 0.8 },
      modulation: { type: 'square' },
      modulationEnvelope: { attack: 0.002, decay: 0.2, sustain: 0, release: 0.2 },
    },
  };
}

/** A filter-swept `MonoSynth`; `octaves` is how far the sweep opens, which is brightness. */
function filterSwept(envelope: object, filterEnvelope: object, octaves: number): SynthSpec {
  return {
    voice: Tone.MonoSynth,
    options: {
      oscillator: { type: 'sawtooth' },
      envelope,
      filterEnvelope: { ...filterEnvelope, octaves },
    },
  };
}

const BASS_ENVELOPE = { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.3 };
const BASS_FILTER = { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.4, baseFrequency: 80 };
const BRASS_ENVELOPE = { attack: 0.06, decay: 0.15, sustain: 0.8, release: 0.3 };
const BRASS_FILTER = { attack: 0.05, decay: 0.2, sustain: 0.6, release: 0.4, baseFrequency: 300 };

/**
 * Every family, in GM order.
 *
 * `PolySynth` throughout for the pitched voices: a bare monophonic Tone
 * instrument drops any note that starts while another is sounding, which is
 * what a chord, an octave double or two parts landing together all look like.
 */
export const VOICES: Record<InstrumentCategory, VoiceSpec> = {
  /** Struck strings: bright when hit hard, and never truly sustaining. */
  piano: { kind: 'custom', build: createPianoInstrument },
  'electric-piano': { kind: 'layers', dark: electricPiano(8), bright: electricPiano(26) },
  /** Celesta, glockenspiel, music box, dulcimer: a middling metallic ring. */
  'chromatic-percussion': {
    kind: 'single',
    synth: malletSpec({ harmonicity: 5.1, modulationIndex: 8, attack: 0.001, decay: 1.4, release: 1.4, modDecay: 0.15 }),
  },
  /** Marimba, xylophone: struck *wood*, damped by its own material almost at once. */
  'mallet-wood': {
    kind: 'single',
    synth: malletSpec({ harmonicity: 3.5, modulationIndex: 6, attack: 0.001, decay: 0.35, release: 0.25, modDecay: 0.08 }),
  },
  /** Metal bars over resonators, so it rings for seconds where a celesta does not. */
  vibraphone: {
    kind: 'single',
    synth: malletSpec({ harmonicity: 4.0, modulationIndex: 7, attack: 0.002, decay: 3.5, release: 2.5, modDecay: 0.4 }),
  },
  /** The longest ring in General MIDI: struck tubes sound many seconds later. */
  'tubular-bell': {
    kind: 'single',
    synth: malletSpec({ harmonicity: 5.6, modulationIndex: 10, attack: 0.002, decay: 7, release: 5, modDecay: 0.6 }),
  },
  /** A plectrum plucks with a force the player cannot vary — hence `fixed`. */
  harpsichord: {
    kind: 'fixed',
    synth: {
      voice: Tone.Synth,
      options: {
        oscillator: { type: 'sawtooth' },
        envelope: { attack: 0.002, decay: 0.7, sustain: 0, release: 0.3 },
      },
    },
  },
  /** Drawbar/church organ, accordion, harmonica: instant on, full sustain, instant off. A key is a switch, so `fixed`. */
  organ: {
    kind: 'fixed',
    synth: {
      voice: Tone.Synth,
      options: {
        // `fatsine` stacks detuned copies, standing in for drawbar registration.
        oscillator: { type: 'fatsine', count: 3, spread: 20 },
        envelope: { attack: 0.01, decay: 0, sustain: 1, release: 0.08 },
      },
    },
  },
  /** Guitars and the plucked ethnic instruments; plucked harder is brighter and wirier. */
  plucked: oscillatorLayers({ attack: 0.003, decay: 0.9, sustain: 0, release: 0.5 }, 'triangle', 'sawtooth'),
  /** Overdriven/distortion guitar: a plucked attack that then *holds*, because a driven amp keeps feeding the string. */
  'guitar-driven': oscillatorLayers(
    { attack: 0.005, decay: 0.25, sustain: 0.55, release: 0.35 },
    'triangle',
    'sawtooth',
  ),
  /** Dug in harder, a bass string opens the filter — how far is the velocity axis. */
  bass: {
    kind: 'layers',
    dark: filterSwept(BASS_ENVELOPE, BASS_FILTER, 1.8),
    bright: filterSwept(BASS_ENVELOPE, BASS_FILTER, 4),
  },
  /** Bowed: more bow pressure is more harmonics, not just more level. */
  strings: oscillatorLayers({ attack: 0.25, decay: 0.3, sustain: 0.8, release: 1.2 }, 'triangle', 'sawtooth'),
  /** String/choir ensembles: like `strings` but detuned and slower, for the massed effect. */
  ensemble: {
    kind: 'single',
    synth: {
      voice: Tone.Synth,
      options: {
        oscillator: { type: 'fatsawtooth', count: 3, spread: 30 },
        envelope: { attack: 0.4, decay: 0.4, sustain: 0.85, release: 1.6 },
      },
    },
  },
  /** The family velocity changes most: leant on, a trumpet turns brassy, and that blare is the filter opening. */
  brass: {
    kind: 'layers',
    dark: filterSwept(BRASS_ENVELOPE, BRASS_FILTER, 2),
    bright: filterSwept(BRASS_ENVELOPE, BRASS_FILTER, 4.5),
  },
  /** Saxes, oboe, clarinet, bassoon: harder breath makes a reed buzz, which is the square end of the pair. */
  reed: oscillatorLayers({ attack: 0.04, decay: 0.2, sustain: 0.75, release: 0.25 }, 'triangle', 'square'),
  /** Flute, piccolo, recorder, whistle: near-pure tone with a breathy onset. */
  pipe: {
    kind: 'single',
    synth: {
      voice: Tone.Synth,
      options: {
        oscillator: { type: 'sine' },
        envelope: { attack: 0.08, decay: 0.1, sustain: 0.9, release: 0.3 },
      },
    },
  },
  'synth-lead': oscillatorLayers({ attack: 0.02, decay: 0.1, sustain: 0.7, release: 0.2 }, 'triangle', 'square'),
  /** Much slower in and far longer out than `strings`, which is what makes it a pad. */
  'synth-pad': {
    kind: 'single',
    synth: {
      voice: Tone.Synth,
      options: {
        oscillator: { type: 'fatsine', count: 3, spread: 40 },
        envelope: { attack: 0.6, decay: 0.5, sustain: 0.9, release: 3 },
      },
    },
  },
  /** FX 1-8: amplitude-modulated and deliberately unstable, but still pitched. */
  'synth-effects': {
    kind: 'single',
    synth: {
      voice: Tone.AMSynth,
      options: {
        harmonicity: 2.5,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.3, decay: 0.6, sustain: 0.5, release: 1.5 },
        modulation: { type: 'square' },
        modulationEnvelope: { attack: 0.4, decay: 0.3, sustain: 0.6, release: 1 },
      },
    },
  },
  /**
   * Fret noise, breath, seashore, applause, gunshot: concrete noises with no
   * pitch. Sharing the pitched FX voice gave a gunshot a note.
   */
  'noise-effects': {
    kind: 'custom',
    build: () =>
      noiseVoice({ noise: { type: 'pink' }, envelope: { attack: 0.01, decay: 0.6, sustain: 0.1, release: 0.5 } }),
  },
  /** Reverse Cymbal: a cymbal played backwards, so it *swells* into its own end. The long attack is the instrument. */
  'reverse-swell': {
    kind: 'custom',
    build: () =>
      noiseVoice({ noise: { type: 'white' }, envelope: { attack: 1.2, decay: 0.02, sustain: 0, release: 0.04 } }),
  },
  /** Orchestra Hit: one short, loud, full-spectrum tutti chord — the opposite of a pad. */
  stab: {
    kind: 'single',
    synth: {
      voice: Tone.Synth,
      options: {
        oscillator: { type: 'fatsawtooth', count: 3, spread: 25 },
        envelope: { attack: 0.004, decay: 0.4, sustain: 0, release: 0.25 },
      },
    },
  },
  /** Taiko, melodic tom, steel drums: pitched percussion, a struck membrane that rings. */
  percussive: {
    kind: 'single',
    synth: {
      voice: Tone.MembraneSynth,
      options: {
        octaves: 2,
        envelope: { attack: 0.001, decay: 1.2, sustain: 0, release: 0.8 },
      },
    },
  },
  'drum-kit': { kind: 'custom', build: createDrumKitInstrument },
};

/**
 * The one cast in this file. Tone ties a `PolySynth`'s options type to the
 * specific voice class it wraps, and this table deliberately holds five
 * different ones; the alternative is a factory function per family, which is
 * exactly the repetition the table replaces.
 */
const PolySynthOf = Tone.PolySynth as unknown as new (
  voice: VoiceClass,
  options: Record<string, unknown>,
) => Parameters<typeof wrapVoice>[0];

function poly({ voice, options }: SynthSpec): InstrumentHandle {
  return wrapVoice(new PolySynthOf(voice, options));
}

/** Realises a spec. The dark layer is built first, so a pair is always ordered dark then bright. */
export function buildVoice(category: InstrumentCategory): InstrumentHandle {
  const spec = VOICES[category];
  switch (spec.kind) {
    case 'single':
      return poly(spec.synth);
    case 'layers':
      return withVelocityTimbre(poly(spec.dark), poly(spec.bright));
    case 'fixed':
      return withFixedVelocity(poly(spec.synth), FIXED_VELOCITY);
    case 'custom':
      return spec.build();
  }
}
