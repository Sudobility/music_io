/**
 * Instrument factories (spec §10, Task 13 brief): one synthesized voice per
 * General MIDI family (sixteen in all, see `InstrumentCategory`), chosen by
 * `createInstrument(nameOrProgram, isPercussion)` from a track's
 * `instrumentName` (free text, e.g. "Electric Piano") or `midiProgram`
 * (General MIDI program number). `tone-engine.ts` is the only intended
 * caller — it does the tick/tempo/scheduling work and just needs a uniform
 * `InstrumentHandle` per track.
 *
 * "Synthesized, fallback synth if samples unavailable; structure so
 * SoundFont/sample libraries can be added later" (spec §10): no sample
 * assets are bundled with this repo yet, so `PIANO_SAMPLE_URLS` is empty
 * and `createPianoInstrument` always takes the synth-fallback branch today
 * — but that branch is real, exercised code (not a stub), so populating
 * the map (and setting a `baseUrl`) later is a one-line change with no
 * call-site impact anywhere else.
 */
import * as Tone from 'tone';
import { midiToHertz } from './midi.js';
import { gmInstrument } from '../../domain/instruments/gm.js';
import type { GmFamily } from '../../domain/instruments/gm.js';

/**
 * The uniform shape `tone-engine.ts` schedules through, regardless of which
 * underlying Tone.js instrument(s) back it. `velocity` is Tone's normalized
 * 0-1 range (not the domain's 0-127 `NoteEvent.velocity`) — callers convert
 * via `midi.ts`'s `normalizeVelocity` before calling in, keeping this
 * module free of any domain-velocity-range assumption.
 */
export type InstrumentHandle = {
  triggerAttackRelease(midi: number, durationSeconds: number, time: number, velocity: number): void;
  connect(node: Tone.ToneAudioNode): void;
  dispose(): void;
};

/**
 * One synthesized voice per General MIDI family, plus `electric-piano` (which
 * splits the piano family) and `drum-kit` (chosen by clef, not program).
 * `plucked` covers both guitar and ethnic, and `synth-effects` covers both FX
 * families — the only two places a voice is shared, because the timbres really
 * are the same shape.
 */
export type InstrumentCategory =
  | 'piano'
  | 'electric-piano'
  | 'chromatic-percussion'
  | 'organ'
  | 'plucked'
  | 'bass'
  | 'strings'
  | 'ensemble'
  | 'brass'
  | 'reed'
  | 'pipe'
  | 'synth-lead'
  | 'synth-pad'
  | 'synth-effects'
  | 'percussive'
  | 'drum-kit';

// ---- category resolution ---------------------------------------------------

const NAME_CATEGORY_PATTERNS: Array<[RegExp, InstrumentCategory]> = [
  [/drum|percussion|\bkit\b/i, 'drum-kit'],
  [/electric.?piano|rhodes|wurlitzer|e\.?\s?piano/i, 'electric-piano'],
  [/\bpad\b/i, 'synth-pad'],
  [/organ|accordion|harmonica/i, 'organ'],
  // Word-bounded `lute` and `harp`: "Flute" contains the first and
  // "Harpsichord" the second, and both belong to other families.
  [/guitar|sitar|banjo|koto|shamisen|\blute\b|\bharp\b/i, 'plucked'],
  [/trumpet|trombone|tuba|horn|brass/i, 'brass'],
  [/sax|oboe|clarinet|bassoon|reed/i, 'reed'],
  [/flute|piccolo|recorder|whistle|ocarina|pipe/i, 'pipe'],
  [/celesta|glocken|vibraphone|marimba|xylophone|music box|bell/i, 'chromatic-percussion'],
  [/ensemble|choir|voice|aahs|oohs/i, 'ensemble'],
  [/string|violin|viola|cello|orchestra/i, 'strings'],
  [/bass/i, 'bass'],
  [/synth.?lead|\blead\b|square/i, 'synth-lead'],
];

/** Category for a free-text `instrumentName`, defaulting to `'piano'` for anything unmatched (including plain "Piano"). */
function categoryForName(name: string): InstrumentCategory {
  for (const [pattern, category] of NAME_CATEGORY_PATTERNS) {
    if (pattern.test(name)) return category;
  }
  return 'piano';
}

/**
 * The synth voice for each GM family — one apiece, so a trumpet no longer
 * shares a voice with a flute or an organ.
 *
 * Two families deliberately share: `ethnic` joins `guitar` on `plucked` (sitar,
 * banjo, koto and shamisen are all plucked strings), and `sound-effects` joins
 * `synth-effects` (both are noise/modulation textures rather than pitched
 * instruments). Everything else has its own.
 *
 * These are synthesized approximations, not samples. A trumpet is a sawtooth
 * with a filter bite and a medium attack — recognisably brass-shaped rather
 * than genuinely a trumpet. Real fidelity needs a sample library, which the
 * module doc explains the code is already structured for.
 */
const FAMILY_CATEGORY: Record<GmFamily, InstrumentCategory> = {
  piano: 'piano',
  'chromatic-percussion': 'chromatic-percussion',
  organ: 'organ',
  guitar: 'plucked',
  bass: 'bass',
  strings: 'strings',
  ensemble: 'ensemble',
  brass: 'brass',
  reed: 'reed',
  pipe: 'pipe',
  'synth-lead': 'synth-lead',
  'synth-pad': 'synth-pad',
  'synth-effects': 'synth-effects',
  ethnic: 'plucked',
  percussive: 'percussive',
  'sound-effects': 'synth-effects',
};

/** Category for a General MIDI program number (0-indexed GM1 sound set); `'piano'` for anything outside 0-127. */
function categoryForProgram(program: number): InstrumentCategory {
  const instrument = gmInstrument(program);
  if (!instrument) return 'piano';
  // Electric Piano 1/2 sit in the piano family but have their own voice.
  if (program === 4 || program === 5) return 'electric-piano';
  return FAMILY_CATEGORY[instrument.family];
}

/** Resolves the synthesized voice category for a track (`isPercussion` — a `percussion`-clef track per spec §4 — always wins, matching a GM drum-channel track regardless of its nominal program/name). */
export function resolveInstrumentCategory(nameOrProgram: string | number, isPercussion: boolean): InstrumentCategory {
  if (isPercussion) return 'drum-kit';
  return typeof nameOrProgram === 'number' ? categoryForProgram(nameOrProgram) : categoryForName(nameOrProgram);
}

// ---- pitched-voice wiring ---------------------------------------------------

/** The minimal shape every pitched Tone.js instrument used below satisfies. */
type PitchedVoice = Tone.ToneAudioNode & {
  triggerAttackRelease(note: number, duration: number, time?: number, velocity?: number): unknown;
};

function wrapVoice(voice: PitchedVoice): InstrumentHandle {
  return {
    triggerAttackRelease(midi, durationSeconds, time, velocity) {
      voice.triggerAttackRelease(midiToHertz(midi), durationSeconds, time, velocity);
    },
    connect(node) {
      voice.connect(node);
    },
    dispose() {
      voice.dispose();
    },
  };
}

// ---- piano (Sampler with synth fallback) ------------------------------------

/** See module doc: empty today (no bundled samples), by design. */
const PIANO_SAMPLE_URLS: Record<string, string> = {};

function createPianoFallbackSynth(): Tone.PolySynth<Tone.Synth> {
  return new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.005, decay: 0.35, sustain: 0.15, release: 0.6 },
  });
}

function createPianoInstrument(): InstrumentHandle {
  if (Object.keys(PIANO_SAMPLE_URLS).length === 0) {
    return wrapVoice(createPianoFallbackSynth());
  }
  try {
    return wrapVoice(new Tone.Sampler({ urls: PIANO_SAMPLE_URLS }));
  } catch {
    return wrapVoice(createPianoFallbackSynth());
  }
}

// ---- electric piano (FM) ----------------------------------------------------

function createElectricPianoInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3.01,
      modulationIndex: 14,
      envelope: { attack: 0.001, decay: 1.2, sustain: 0.1, release: 0.8 },
      modulation: { type: 'square' },
      modulationEnvelope: { attack: 0.002, decay: 0.2, sustain: 0, release: 0.2 },
    }),
  );
}

// ---- strings (slow-attack PolySynth) ----------------------------------------

function createStringsInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.6, decay: 0.3, sustain: 0.8, release: 1.2 },
    }),
  );
}

// ---- bass (MonoSynth) --------------------------------------------------------

function createBassInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.3 },
      filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.4, baseFrequency: 80, octaves: 2.5 },
    }),
  );
}

// ---- synth lead (PolySynth square) ------------------------------------------

function createSynthLeadInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'square' },
      envelope: { attack: 0.02, decay: 0.1, sustain: 0.7, release: 0.2 },
    }),
  );
}

// ---- per-family voices ------------------------------------------------------
//
// Each is a synthesized approximation shaped like the family, not a sample of
// it: the envelope and oscillator carry the family's character (struck vs
// plucked vs sustained vs breathy), which is what makes a brass line read as
// brass next to a flute line. See `FAMILY_CATEGORY` above for the trade.

/** Celesta, glockenspiel, vibraphone, marimba: struck metal/wood — bright, inharmonic, no sustain. */
function createChromaticPercussionInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 5.1, // inharmonic ratio is what makes it read as a bell
      modulationIndex: 8,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 1.4, sustain: 0, release: 1.4 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.15 },
    }),
  );
}

/** Drawbar/church organ, accordion, harmonica: instant on, full sustain, instant off — no decay at all. */
function createOrganInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.Synth, {
      // `fatsine` stacks detuned copies, standing in for drawbar registration.
      oscillator: { type: 'fatsine', count: 3, spread: 20 },
      envelope: { attack: 0.01, decay: 0, sustain: 1, release: 0.08 },
    }),
  );
}

/** Guitars and the plucked ethnic instruments: hard attack, quick decay, nothing held. */
function createPluckedInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.003, decay: 0.9, sustain: 0, release: 0.5 },
    }),
  );
}

/** String/choir ensembles: like `strings` but detuned and slower, for the massed effect. */
function createEnsembleInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsawtooth', count: 3, spread: 30 },
      envelope: { attack: 0.9, decay: 0.4, sustain: 0.85, release: 1.6 },
    }),
  );
}

/** Trumpet, trombone, horn: sustained with a bite — the filter sweep is the brassiness. */
function createBrassInstrument(): InstrumentHandle {
  const voice = new Tone.PolySynth(Tone.MonoSynth, {
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.06, decay: 0.15, sustain: 0.8, release: 0.3 },
    filterEnvelope: {
      attack: 0.05,
      decay: 0.2,
      sustain: 0.6,
      release: 0.4,
      baseFrequency: 300,
      octaves: 3,
    },
  });
  return wrapVoice(voice);
}

/** Saxes, oboe, clarinet, bassoon: square-ish and woody, quicker on than brass. */
function createReedInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'square' },
      envelope: { attack: 0.04, decay: 0.2, sustain: 0.75, release: 0.25 },
    }),
  );
}

/** Flute, piccolo, recorder, whistle: near-pure tone with a breathy onset. */
function createPipeInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' },
      envelope: { attack: 0.08, decay: 0.1, sustain: 0.9, release: 0.3 },
    }),
  );
}

/** Synth pads: much slower in and far longer out than `strings`, which is what makes it a pad. */
function createSynthPadInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsine', count: 3, spread: 40 },
      envelope: { attack: 1.6, decay: 0.5, sustain: 0.9, release: 3 },
    }),
  );
}

/** FX and sound-effect programs: amplitude-modulated and deliberately unstable. */
function createSynthEffectsInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.AMSynth, {
      harmonicity: 2.5,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.3, decay: 0.6, sustain: 0.5, release: 1.5 },
      modulation: { type: 'square' },
      modulationEnvelope: { attack: 0.4, decay: 0.3, sustain: 0.6, release: 1 },
    }),
  );
}

/** Taiko, melodic tom, steel drums, woodblock: pitched percussion — a struck membrane, unlike the unpitched kit. */
function createPercussiveInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.MembraneSynth({
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.5 },
    }),
  );
}

// ---- drum kit (MembraneSynth kick / NoiseSynth snare+hat) ------------------

/** GM percussion note numbers routed to the kick voice (bass drums + toms — pitched, membrane-appropriate). */
const KICK_NOTES = new Set([35, 36, 41, 43, 45, 47, 48, 50]);
/** GM percussion note numbers routed to the snare voice. */
const SNARE_NOTES = new Set([37, 38, 39, 40]);
/** Everything else (hi-hats, cymbals, other unpitched percussion) routes to the brighter/shorter "hat" noise voice. */

/**
 * Half a millisecond: inaudible, but enough to satisfy Tone's
 * strictly-increasing source-start assertion (see `monotonicTime`).
 */
const MONO_RETRIGGER_EPSILON_SECONDS = 0.0005;

/**
 * Per-voice start-time monotonizer. Tone's single-source instruments
 * (`NoiseSynth`'s underlying `Noise`) assert that each `start(time)` is
 * STRICTLY greater than the previous one — but a real percussion track
 * routinely lands two hits on the same voice at the same tick (e.g. closed
 * + open hi-hat from a MIDI drum pattern, both routed to the `hat` voice).
 * Untreated, the second `triggerAttackRelease` threw inside the Transport
 * callback, and that exception aborted the rest of the audio tick's event
 * batch — starving the position ticker (frozen caret) mid-playback.
 * Nudging a colliding (or out-of-order) hit forward by half a millisecond
 * keeps the source legal and is inaudible.
 */
function monotonicTime(): (time: number) => number {
  let last = Number.NEGATIVE_INFINITY;
  return (time) => {
    const t = time <= last ? last + MONO_RETRIGGER_EPSILON_SECONDS : time;
    last = t;
    return t;
  };
}

function createDrumKitInstrument(): InstrumentHandle {
  const kick = new Tone.MembraneSynth({
    envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.4 },
  });
  const snare = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 },
  });
  const hat = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
  });
  const hatFilter = new Tone.Filter(7000, 'highpass');
  hat.connect(hatFilter);

  const output = new Tone.Gain(1);
  kick.connect(output);
  snare.connect(output);
  hatFilter.connect(output);

  const kickTime = monotonicTime();
  const snareTime = monotonicTime();
  const hatTime = monotonicTime();

  return {
    triggerAttackRelease(midi, durationSeconds, time, velocity) {
      if (KICK_NOTES.has(midi)) {
        kick.triggerAttackRelease(midiToHertz(midi), durationSeconds, kickTime(time), velocity);
      } else if (SNARE_NOTES.has(midi)) {
        snare.triggerAttackRelease(durationSeconds, snareTime(time), velocity);
      } else {
        hat.triggerAttackRelease(durationSeconds, hatTime(time), velocity);
      }
    },
    connect(node) {
      output.connect(node);
    },
    dispose() {
      kick.dispose();
      snare.dispose();
      hat.dispose();
      hatFilter.dispose();
      output.dispose();
    },
  };
}

// ---- entry point --------------------------------------------------------------

/**
 * Builds the `InstrumentHandle` for a track (spec §10's six synthesized
 * voices). `nameOrProgram` is the track's `instrumentName` or
 * `midiProgram` (either is enough to resolve a category); `isPercussion`
 * should be `true` for a `percussion`-clef track (spec §4), which always
 * yields the drum kit regardless of `nameOrProgram`.
 */
export function createInstrument(nameOrProgram: string | number, isPercussion: boolean): InstrumentHandle {
  const category = resolveInstrumentCategory(nameOrProgram, isPercussion);
  switch (category) {
    case 'piano':
      return createPianoInstrument();
    case 'electric-piano':
      return createElectricPianoInstrument();
    case 'chromatic-percussion':
      return createChromaticPercussionInstrument();
    case 'organ':
      return createOrganInstrument();
    case 'plucked':
      return createPluckedInstrument();
    case 'strings':
      return createStringsInstrument();
    case 'ensemble':
      return createEnsembleInstrument();
    case 'brass':
      return createBrassInstrument();
    case 'reed':
      return createReedInstrument();
    case 'pipe':
      return createPipeInstrument();
    case 'synth-pad':
      return createSynthPadInstrument();
    case 'synth-effects':
      return createSynthEffectsInstrument();
    case 'percussive':
      return createPercussiveInstrument();
    case 'bass':
      return createBassInstrument();
    case 'synth-lead':
      return createSynthLeadInstrument();
    case 'drum-kit':
      return createDrumKitInstrument();
  }
}
