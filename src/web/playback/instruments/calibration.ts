/**
 * Per-family output levels, measured rather than guessed.
 *
 * Kept apart from the voices themselves because the two change for different
 * reasons: a voice changes when an instrument sounds wrong, these numbers
 * change when it is re-measured. Editing a patch invalidates its row here —
 * see the note on re-measuring below.
 */
import * as Tone from 'tone';
import type { InstrumentHandle } from './handle.js';
import type { InstrumentCategory } from './categories.js';

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
 *     piano                   -18.6   0.717      +2.0     -16.6  peak-limited
 *     electric-piano          -25.1   0.310      +9.3     -15.8  peak-limited
 *     chromatic-percussion    -25.8   0.251     +11.1     -14.7  peak-limited
 *     mallet-wood             -30.5   0.250     +11.1     -19.4  peak-limited
 *     vibraphone              -23.4   0.253      +9.4     -14.0
 *     tubular-bell            -22.0   0.253      +8.0     -14.0
 *     harpsichord             -20.6   0.821      +0.8     -19.8  peak-limited
 *     organ                    -8.0   0.874      -6.0     -14.0
 *     plucked                 -18.3   0.749      +1.6     -16.7  peak-limited
 *     guitar-driven           -11.1   0.735      -2.9     -14.0
 *     bass                    -10.9   0.737      -3.1     -14.0
 *     strings                  -8.6   0.744      -5.4     -14.0
 *     ensemble                -15.1   0.657      +1.1     -14.0
 *     brass                    -8.6   0.823      -5.4     -14.0
 *     reed                     -4.7   0.886      -9.3     -14.0
 *     pipe                     -6.1   0.799      -7.9     -14.0
 *     synth-lead               -5.3   0.872      -8.7     -14.0
 *     synth-pad               -12.7   0.748      -1.3     -14.0
 *     synth-effects           -25.7   0.146     +11.7     -14.0
 *     percussive              -16.3   0.795      +1.1     -15.2  peak-limited
 *     stab                    -30.0   0.283     +10.0     -20.0  peak-limited
 *     noise-effects           -27.2   0.392      +7.2     -20.0  peak-limited
 *     reverse-swell           -13.1   0.661      -0.9     -14.0
 *     drum-kit                -19.8   0.796      +1.1     -18.7  peak-limited
 *
 * One row is deliberately pessimistic. A noise voice has no fixed peak — it is
 * a random process, and successive renders of the same patch measured 0.392,
 * 0.44 and 0.60 for `noise-effects`. Calibrating from one sample let a later
 * render peak at 1.38, above full scale on its own. Its row records the worst
 * peak seen rather than the first, which costs a few dB and cannot clip.
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
  piano: { rmsDb: -18.6, peak: 0.717 },
  'electric-piano': { rmsDb: -25.1, peak: 0.31 },
  'chromatic-percussion': { rmsDb: -25.8, peak: 0.251 },
  'mallet-wood': { rmsDb: -30.5, peak: 0.25 },
  vibraphone: { rmsDb: -23.4, peak: 0.253 },
  'tubular-bell': { rmsDb: -22.0, peak: 0.253 },
  harpsichord: { rmsDb: -20.6, peak: 0.821 },
  organ: { rmsDb: -8.0, peak: 0.874 },
  plucked: { rmsDb: -18.3, peak: 0.749 },
  'guitar-driven': { rmsDb: -11.1, peak: 0.735 },
  bass: { rmsDb: -10.9, peak: 0.737 },
  strings: { rmsDb: -8.6, peak: 0.744 },
  ensemble: { rmsDb: -15.1, peak: 0.657 },
  brass: { rmsDb: -8.6, peak: 0.823 },
  reed: { rmsDb: -4.7, peak: 0.886 },
  pipe: { rmsDb: -6.1, peak: 0.799 },
  'synth-lead': { rmsDb: -5.3, peak: 0.872 },
  'synth-pad': { rmsDb: -12.7, peak: 0.748 },
  'synth-effects': { rmsDb: -25.7, peak: 0.146 },
  percussive: { rmsDb: -16.3, peak: 0.795 },
  stab: { rmsDb: -30.0, peak: 0.283 },
  'noise-effects': { rmsDb: -27.2, peak: 0.6 },
  'reverse-swell': { rmsDb: -13.1, peak: 0.661 },
  'drum-kit': { rmsDb: -19.8, peak: 0.796 },
};

/**
 * Bring the family to `CALIBRATION_TARGET_DB`, but never past the point where
 * its measured peak would exceed `CALIBRATION_PEAK_CEILING`.
 */
function calibratedTrimDb({ rmsDb, peak }: { rmsDb: number; peak: number }): number {
  return Math.min(CALIBRATION_TARGET_DB - rmsDb, 20 * Math.log10(CALIBRATION_PEAK_CEILING / peak));
}

export const OUTPUT_TRIM_DB = Object.fromEntries(
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
export function withOutputTrim(handle: InstrumentHandle, db: number): InstrumentHandle {
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
