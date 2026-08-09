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
import { gmInstrument } from '@sudobility/music_lib';
import type { GmFamily } from '@sudobility/music_lib';

/**
 * The uniform shape `tone-engine.ts` schedules through, regardless of which
 * underlying Tone.js instrument(s) back it. `velocity` is Tone's normalized
 * 0-1 range (not the domain's 0-127 `NoteEvent.velocity`) — callers convert
 * via `midi.ts`'s `normalizeVelocity` before calling in, keeping this
 * module free of any domain-velocity-range assumption.
 */
export type InstrumentHandle = {
  triggerAttackRelease(midi: number, durationSeconds: number, time: number, velocity: number): void;
  /**
   * Sustained form, for auditioning a key that is being *held* — the player
   * should hear the note for as long as the key is down, and its length is not
   * known when it starts.
   *
   * Optional because not every voice has a meaningful sustain: a drum kit is
   * struck, not held, so it leaves these out and the caller falls back to a
   * short `triggerAttackRelease`.
   */
  triggerAttack?(midi: number, velocity: number): void;
  triggerRelease?(midi: number): void;
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
  | 'guitar-driven'
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

// ---- output levels ---------------------------------------------------------

/**
 * Per-family output trim, in dB — **measured, not modelled**.
 *
 * Every voice ran at whatever level its oscillators happened to produce, and
 * the spread across families was 24dB: a `pipe` patch (one sine) came out
 * nearly 18dB above a `synth-pad` and 24dB above a hi-hat. No per-track MIDI
 * volume can compensate for that, so a quiet family simply could not be heard
 * next to a loud one and the arrangement lost whole parts.
 *
 * These numbers come from rendering one reference note per family through
 * `createInstrument` in an OfflineAudioContext with every trim at zero, and
 * measuring in-note RMS and peak (C4, velocity 0.8, one second):
 *
 *     family                 rawRMS   peak      trim    result
 *     piano                  -19.0   0.781      +1.2    -17.8  peak-limited
 *     electric-piano         -25.1   0.252     +11.1    -14.0
 *     chromatic-percussion   -25.8   0.251     +11.1    -14.7  peak-limited
 *     organ                   -8.5   0.823      -5.5    -14.0
 *     plucked                -20.3   0.781      +1.2    -19.1  peak-limited
 *     guitar-driven          -13.0   0.766      -1.0    -14.0
 *     bass                   -12.3   0.748      -1.7    -14.0
 *     strings                -10.5   0.776      -3.5    -14.0
 *     ensemble               -15.1   0.657      +1.1    -14.0
 *     brass                  -10.0   0.886      -4.0    -14.0
 *     reed                    -5.9   0.782      -8.1    -14.0
 *     pipe                    -6.1   0.799      -7.9    -14.0
 *     synth-lead              -6.4   0.784      -7.6    -14.0
 *     synth-pad              -12.7   0.748      -1.3    -14.0
 *     synth-effects          -25.7   0.146     +11.7    -14.0
 *     percussive             -16.3   0.795      +1.1    -15.2  peak-limited
 *     drum-kit               -19.8   0.999      -0.9    -20.7  peak-limited
 *
 * The rule is `min(TARGET - rawRMS, headroom to PEAK_CEILING)`: bring every
 * family to a common RMS, but never at the cost of clipping. The families that
 * hit the peak limit are precisely the struck ones — piano, plucked, pitched
 * percussion, the kit — and their sitting lower in RMS is not an error but
 * crest factor: a struck note is a spike followed by decay, so it peaks as
 * loud as a flute while carrying far less average energy. Forcing them to a
 * flute's RMS would make them explode.
 *
 * Re-measure with `tools/calibrate.html` if a voice's oscillators or envelope
 * change — a patch edit invalidates its row here. It needs a bundler that can
 * resolve `tone` and this package plus a real OfflineAudioContext, so drop it
 * into a consuming app's root and open it there.
 */
/** Common in-note RMS every family is brought to, where its peak allows. */
const CALIBRATION_TARGET_DB = -14;
/** No trim may push a family's measured peak above this. */
const CALIBRATION_PEAK_CEILING = 0.9;

/** The measurements above, kept as data so the trims cannot drift from them. */
const MEASURED_RAW: Record<InstrumentCategory, { rmsDb: number; peak: number }> = {
  piano: { rmsDb: -19.0, peak: 0.781 },
  'electric-piano': { rmsDb: -25.1, peak: 0.252 },
  'chromatic-percussion': { rmsDb: -25.8, peak: 0.251 },
  organ: { rmsDb: -8.5, peak: 0.823 },
  plucked: { rmsDb: -20.3, peak: 0.781 },
  'guitar-driven': { rmsDb: -13.0, peak: 0.766 },
  bass: { rmsDb: -12.3, peak: 0.748 },
  strings: { rmsDb: -10.5, peak: 0.776 },
  ensemble: { rmsDb: -15.1, peak: 0.657 },
  brass: { rmsDb: -10.0, peak: 0.886 },
  reed: { rmsDb: -5.9, peak: 0.782 },
  pipe: { rmsDb: -6.1, peak: 0.799 },
  'synth-lead': { rmsDb: -6.4, peak: 0.784 },
  'synth-pad': { rmsDb: -12.7, peak: 0.748 },
  'synth-effects': { rmsDb: -25.7, peak: 0.146 },
  percussive: { rmsDb: -16.3, peak: 0.795 },
  'drum-kit': { rmsDb: -19.8, peak: 0.999 },
};

/**
 * Bring the family to `CALIBRATION_TARGET_DB`, but never past the point where
 * its measured peak would exceed `CALIBRATION_PEAK_CEILING`.
 */
function calibratedTrimDb({ rmsDb, peak }: { rmsDb: number; peak: number }): number {
  return Math.min(CALIBRATION_TARGET_DB - rmsDb, 20 * Math.log10(CALIBRATION_PEAK_CEILING / peak));
}

const OUTPUT_TRIM_DB = Object.fromEntries(
  Object.entries(MEASURED_RAW).map(([category, measured]) => [category, calibratedTrimDb(measured)]),
) as Record<InstrumentCategory, number>;

/** dB to linear gain, computed here rather than via `Tone.dbToGain` so the conversion is testable against a mocked Tone. */
function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Routes `handle` through a fixed gain so families sit at comparable levels.
 * A zero trim is passed through untouched, so no extra node is created for the
 * families that need none.
 */
function withOutputTrim(handle: InstrumentHandle, db: number): InstrumentHandle {
  if (db === 0) return handle;
  const trim = new Tone.Gain(dbToGain(db));
  return {
    ...handle,
    connect(node: Tone.InputNode) {
      handle.connect(trim);
      trim.connect(node);
    },
    dispose() {
      handle.dispose();
      trim.dispose();
    },
  };
}

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
  // Overdriven and Distortion Guitar sit in the guitar family but do not decay
  // like a plucked string — sustain is the whole point of driving an amp. On
  // the plucked voice a two-second note died after 0.56s, so held guitar lines
  // came out chopped. Guitar Harmonics (31) is left plucked: it really does
  // decay.
  if (program === 29 || program === 30) return 'guitar-driven';
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
  triggerAttack?(...args: never[]): unknown;
  triggerRelease?(...args: never[]): unknown;
};

function wrapVoice(voice: PitchedVoice): InstrumentHandle {
  return {
    triggerAttackRelease(midi, durationSeconds, time, velocity) {
      voice.triggerAttackRelease(midiToHertz(midi), durationSeconds, time, velocity);
    },
    triggerAttack(midi, velocity) {
      // Cast at the call: Tone's monophonic and polyphonic voices disagree on
      // these signatures (one takes an optional note, the other a note or list),
      // and both accept a single frequency at runtime.
      (voice.triggerAttack as ((note: number, time?: number, velocity?: number) => unknown) | undefined)?.(
        midiToHertz(midi),
        undefined,
        velocity,
      );
    },
    triggerRelease(midi) {
      (voice.triggerRelease as ((note: number) => unknown) | undefined)?.(midiToHertz(midi));
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
      envelope: { attack: 0.25, decay: 0.3, sustain: 0.8, release: 1.2 },
    }),
  );
}

// ---- bass (PolySynth of MonoSynth voices) -----------------------------------

/**
 * `PolySynth(MonoSynth)`, not a bare `MonoSynth` — the same shape brass uses.
 *
 * A bare MonoSynth has one voice, so a second note starting at the same tick
 * (a chord, an octave double, two voices landing together) made Tone throw
 * "Start time must be strictly greater than previous start time" and the note
 * simply never sounded. Every other pitched instrument here was already
 * polyphonic; bass was the one that was not, which made bass-heavy
 * arrangements play back with holes in them.
 */
function createBassInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.MonoSynth, {
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

/**
 * Overdriven/distortion guitar: a plucked attack that then *holds*, because a
 * driven amp keeps feeding the string. Sawtooth like `plucked`, so it stays
 * recognisably a guitar, but with a real sustain level instead of decaying to
 * silence.
 */
function createDrivenGuitarInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.005, decay: 0.25, sustain: 0.55, release: 0.35 },
    }),
  );
}

/** String/choir ensembles: like `strings` but detuned and slower, for the massed effect. */
function createEnsembleInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsawtooth', count: 3, spread: 30 },
      envelope: { attack: 0.4, decay: 0.4, sustain: 0.85, release: 1.6 },
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
      envelope: { attack: 0.6, decay: 0.5, sustain: 0.9, release: 3 },
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

/**
 * Taiko, melodic tom, steel drums, woodblock: pitched percussion — a struck
 * membrane, unlike the unpitched kit.
 *
 * `PolySynth(MembraneSynth)`, not a bare `MembraneSynth`, for exactly the
 * reason the bass is a `PolySynth(MonoSynth)`: a MembraneSynth has one
 * oscillator, so a second note starting at the same moment made Tone throw
 * "Start time must be strictly greater than previous start time" and that note
 * never sounded. These are melodic parts played on an ordinary channel — a
 * synth-tom line hits several notes at once routinely, and one real file
 * peaked at fourteen — so every overlap past the first was being dropped.
 */
function createPercussiveInstrument(): InstrumentHandle {
  return wrapVoice(
    new Tone.PolySynth(Tone.MembraneSynth, {
      octaves: 2,
      // Rings rather than clicks: a taiko or steel drum has a long tail, and at
      // decay 0.5 a two-second note was gone after 0.35s.
      envelope: { attack: 0.001, decay: 1.2, sustain: 0, release: 0.8 },
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

/**
 * What to resolve a track's synthesized voice from: its GM program number when
 * it has a meaningful one, otherwise its free-text instrument name.
 *
 * The program is a precise, standardised identifier; the name is prose. Every
 * path that writes a track here derives the name *from* the program (the track
 * editor patches both together for exactly that reason), so where the two
 * disagree it is the name that is lossy — and reading the name first meant the
 * precise program was never consulted at all.
 *
 * What that cost: the Percussive family (GM 112-119) is full of *pitched*
 * instruments whose names read as drums — "Synth Drum", "Steel Drums", "Taiko
 * Drum". Matched by name, each was handed the unpitched kit and played back as
 * bursts of noise instead of notes.
 *
 * Program 0 falls through to the name because it is ambiguous: it is both
 * "Acoustic Grand Piano" and the value a track gets when nothing ever set one
 * (a MusicXML part may name an instrument and give no program). Nothing is lost
 * by reading the name in that case — a name matching no pattern resolves to
 * piano, which is what program 0 means anyway.
 *
 * A percussion clef still wins over both: that is the score stating outright
 * that the track is a kit, and a GM drum track's program byte is meaningless
 * (one real file's was 16, a drawbar organ).
 */
export function voiceSourceFor(track: { midiProgram: number; instrumentName: string }): string | number {
  if (track.midiProgram > 0) return track.midiProgram;
  return track.instrumentName || track.midiProgram;
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
  return withOutputTrim(createForCategory(category), OUTPUT_TRIM_DB[category]);
}

function createForCategory(category: InstrumentCategory): InstrumentHandle {
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
    case 'guitar-driven':
      return createDrivenGuitarInstrument();
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
