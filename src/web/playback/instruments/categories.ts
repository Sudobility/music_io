/**
 * Which synthesized voice a track gets, and why.
 *
 * Two questions live here and nothing else: what the categories *are*, and how
 * a track's program, name or clef picks one. The voices themselves are in
 * `voices.ts`, so this file can be read as a statement about General MIDI
 * rather than about synthesis.
 */
import { gmInstrument } from '@sudobility/music_lib';
import type { GmFamily } from '@sudobility/music_lib';

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
  | 'mallet-wood'
  | 'vibraphone'
  | 'tubular-bell'
  | 'harpsichord'
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
  | 'noise-effects'
  | 'reverse-swell'
  | 'stab'
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
  // Fret noise, breath, seashore, applause, gunshot: concrete *noises*, with no
  // pitch to speak of. They used to share the pitched AM-sine FX voice, which
  // gave a gunshot a note.
  'sound-effects': 'noise-effects',
};

/**
 * Programs whose GM family does not describe them.
 *
 * The GM families are groupings of convenience, not of behaviour: the strings
 * family ends with a plucked pair and a drum, the piano family ends with two
 * plucked keyboards, and the ensemble family ends with a stab. Taking the
 * family voice for these makes a timpani sound like a bowed cello and a
 * harpsichord ring like a piano, so each is named here instead.
 *
 * Kept as a table rather than a chain of `if`s because it is a list of facts
 * about General MIDI, and reads as one.
 */
const PROGRAM_CATEGORY: Record<number, InstrumentCategory> = {
  6: 'harpsichord', // plucked strings, and no dynamics at all
  7: 'harpsichord', // Clavinet — plucked/struck, and likewise fixed in level
  // The chromatic-percussion family spans a thirty-fold range of ring time,
  // from a xylophone's dry click to tubular bells still sounding ten seconds
  // later. One decay for all eight made every one of them wrong.
  11: 'vibraphone', // long, sustained by its resonators
  12: 'mallet-wood', // Marimba — wood, short
  13: 'mallet-wood', // Xylophone — wood, shorter still
  14: 'tubular-bell', // rings far longer than anything else in the family
  45: 'plucked', // Pizzicato Strings — the one plucked entry in the strings family
  46: 'plucked', // Orchestral Harp — likewise
  47: 'percussive', // Timpani — a struck membrane filed under strings
  55: 'stab', // Orchestra Hit — a single short tutti chord, not a pad
  119: 'reverse-swell', // Reverse Cymbal — plays backwards: it swells, then stops
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
  return PROGRAM_CATEGORY[program] ?? FAMILY_CATEGORY[instrument.family];
}

/** Resolves the synthesized voice category for a track (`isPercussion` — a `percussion`-clef track per spec §4 — always wins, matching a GM drum-channel track regardless of its nominal program/name). */
export function resolveInstrumentCategory(nameOrProgram: string | number, isPercussion: boolean): InstrumentCategory {
  if (isPercussion) return 'drum-kit';
  return typeof nameOrProgram === 'number' ? categoryForProgram(nameOrProgram) : categoryForName(nameOrProgram);
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
