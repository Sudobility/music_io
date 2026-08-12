#!/usr/bin/env node
/**
 * Measures how each General MIDI instrument responds to velocity, by rendering
 * it and listening — not by reading the soundfont's generators.
 *
 * The pre-rendered packs the RN engine plays are recordings taken at full
 * velocity, so they carry no velocity response: a pianissimo note is the
 * fortissimo recording turned down. Real fluidsynth also makes it *darker*,
 * through the SF2 velocity-to-filter-cutoff modulator. This script recovers
 * that, per instrument, as a cutoff frequency the engine applies with one
 * biquad.
 *
 * **Why measured rather than extracted.** The first attempt parsed `initialFilterFc`
 * out of the `pdta` chunk, which is readable even in SF3. It gave Grand Piano a
 * 300Hz low-pass — plainly wrong, since the rendered piano has energy out to
 * 4.6kHz. The reason is layering: FluidR3's piano preset points at two
 * instruments at once and the recording is their sum, so no single layer's
 * filter describes it. Generators cannot be read off a layered preset. The
 * sound can.
 *
 * Method: render C4 at several velocities, take the spectrum of each a quarter
 * second in (past the attack transient), and find where the quiet spectrum
 * falls 3dB below the loud one. That crossing *is* the effective filter corner,
 * whatever produced it — modulator, mod-envelope, layer crossfade or all three.
 *
 * Release is measured the same way: hold a note, release it, and time the decay
 * to -60dB.
 *
 * Usage:
 *   node scripts/measure-expression.mjs \
 *     --soundfont ../music_app/public/audio/FluidR3Mono_GM.sf3 \
 *     --out src/rn/playback/expression-table.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PPQ = 480;
const SAMPLE_RATE = 44100;
const NOTE = 60;
/** Velocities probed. 127 is the reference the packs were rendered at. */
const VELOCITIES = [127, 96, 64, 32, 16];
/** Seconds between probes. Long enough for a release to finish before the next. */
const SLOT_SECONDS = 3;
/** How long the key is held, in slot terms; the rest of the slot is the release. */
const HOLD_SECONDS = 1.5;
const FFT_SIZE = 16384;
/** Analysis window offset into the note — past the attack, inside the sustain. */
const ANALYSIS_OFFSET = 0.25;
/** Below this the two spectra are the same and no filter is wanted. */
const NYQUIST_GUARD = 18000;

function arg(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) throw new Error(`Missing required argument ${flag}`);
  return process.argv[i + 1];
}

const vlq = (n) => {
  const out = [n & 0x7f];
  let rest = n >>> 7;
  while (rest > 0) {
    out.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return out;
};
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** Every (program, velocity) probe in one file, so the font loads once. */
function buildProbeMidi() {
  const slotTicks = SLOT_SECONDS * 2 * PPQ; // 480 ticks = 0.5s at the default 120bpm
  const holdTicks = HOLD_SECONDS * 2 * PPQ;
  const events = [];
  let delta = 0;
  for (let program = 0; program < 128; program += 1) {
    for (const velocity of VELOCITIES) {
      events.push(...vlq(delta), 0xc0, program);
      events.push(...vlq(0), 0x90, NOTE, velocity);
      events.push(...vlq(holdTicks), 0x80, NOTE, 0);
      delta = slotTicks - holdTicks;
    }
  }
  events.push(...vlq(slotTicks), 0xff, 0x2f, 0x00);
  return Buffer.from([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (PPQ >> 8) & 255, PPQ & 255,
    0x4d, 0x54, 0x72, 0x6b, ...u32(events.length), ...events,
  ]);
}

function readWavMono(path) {
  const data = readFileSync(path);
  let offset = 12;
  let channels = 2;
  let pcm = null;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === 'fmt ') channels = data.readUInt16LE(offset + 10);
    if (id === 'data') {
      pcm = data.subarray(offset + 8, offset + 8 + size);
      break;
    }
    offset += 8 + size + (size & 1);
  }
  if (!pcm) throw new Error('No data chunk');
  const frames = Math.floor(pcm.length / 2 / channels);
  const mono = new Float64Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += pcm.readInt16LE((f * channels + c) * 2) / 32768;
    mono[f] = sum / channels;
  }
  return mono;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k += 1) {
        const c = Math.cos(ang * k);
        const s = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * c - im[i + k + len / 2] * s;
        const vi = re[i + k + len / 2] * s + im[i + k + len / 2] * c;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

/** Magnitude spectrum of a Hann-windowed frame starting at `from`. */
function spectrum(signal, from) {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i += 1) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
    re[i] = (signal[from + i] ?? 0) * w;
  }
  fft(re, im);
  const mag = new Float64Array(FFT_SIZE / 2);
  for (let k = 0; k < mag.length; k += 1) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}

/** Summed power between two frequencies. */
function bandEnergy(mag, fLo, fHi) {
  const binHz = SAMPLE_RATE / FFT_SIZE;
  const lo = Math.max(1, Math.floor(fLo / binHz));
  const hi = Math.min(mag.length - 1, Math.ceil(fHi / binHz));
  let sum = 0;
  for (let k = lo; k <= hi; k += 1) sum += mag[k] * mag[k];
  return sum;
}

/**
 * Around the fundamental of the probe note (C4, 261.6Hz). Both spectra are
 * normalised here before being compared.
 *
 * Normalising is the whole trick, and forgetting it produced a table where all
 * 128 instruments read 281Hz: a quiet note is quieter at *every* frequency, so
 * an un-normalised comparison finds the first band it looks at already 3dB
 * down and stops. The filter is a change in spectral **shape**, which only
 * shows once the level difference is divided out.
 */
const REFERENCE_LO = 200;
const REFERENCE_HI = 350;

/**
 * The frequency above which `quiet` has lost more than 3dB *relative to its own
 * fundamental* than `loud` has.
 *
 * That crossing is the effective low-pass corner between the two velocities,
 * whatever produced it — modulator, mod-envelope, layer crossfade or all three.
 * Compared in sixth-octave bands rather than per bin, because a single bin of a
 * harmonic spectrum is mostly the noise between partials.
 */
function cutoffBetween(loud, quiet) {
  const normLoud = bandEnergy(loud, REFERENCE_LO, REFERENCE_HI);
  const normQuiet = bandEnergy(quiet, REFERENCE_LO, REFERENCE_HI);
  if (normLoud <= 0 || normQuiet <= 0) return null;

  let previousBelow = false;
  for (let f = REFERENCE_HI * 2 ** (1 / 6); f < NYQUIST_GUARD; f *= 2 ** (1 / 6)) {
    const el = bandEnergy(loud, f / 2 ** (1 / 12), f * 2 ** (1 / 12)) / normLoud;
    const eq = bandEnergy(quiet, f / 2 ** (1 / 12), f * 2 ** (1 / 12)) / normQuiet;
    if (el <= 0) continue;
    const dB = 10 * Math.log10((eq + 1e-20) / el);
    // Two consecutive bands down: one alone is as likely to be a spectral dip.
    if (dB < -3) {
      if (previousBelow) return Math.round(f);
      previousBelow = true;
    } else {
      previousBelow = false;
    }
  }
  return null; // no darkening: this instrument's timbre does not track velocity
}

/**
 * Seconds from note-off until the level has fallen 40dB.
 *
 * -40dB rather than -60: at -60 more than half the catalogue was still ringing
 * when the probe slot ended and came back unmeasured. -40dB is the point the
 * tail stops mattering against anything else playing.
 */
function measureRelease(signal, releaseFrom) {
  const window = Math.round(0.01 * SAMPLE_RATE);
  const rmsAt = (at) => {
    let sum = 0;
    for (let i = 0; i < window; i += 1) sum += (signal[at + i] ?? 0) ** 2;
    return Math.sqrt(sum / window);
  };
  const start = rmsAt(releaseFrom);
  if (start <= 1e-6) return null;
  const floor = start / 100; // -40dB
  for (let at = releaseFrom; at < releaseFrom + SAMPLE_RATE * (SLOT_SECONDS - HOLD_SECONDS); at += window) {
    if (rmsAt(at) < floor) return Number(((at - releaseFrom) / SAMPLE_RATE).toFixed(3));
  }
  return null; // still ringing at the end of the slot
}

/**
 * Whether the instrument holds its level while the key is down.
 *
 * Decides whether a note longer than the 3.13s recording may be sustained by
 * looping the tail. A bowed or blown instrument holds, so looping is right; a
 * piano or marimba is already decaying, and looping its tail would hold a note
 * that should have died away.
 */
function measureSustain(signal, noteStart) {
  const window = Math.round(0.05 * SAMPLE_RATE);
  const rmsAt = (seconds) => {
    const at = noteStart + Math.round(seconds * SAMPLE_RATE);
    let sum = 0;
    for (let i = 0; i < window; i += 1) sum += (signal[at + i] ?? 0) ** 2;
    return Math.sqrt(sum / window);
  };
  const early = rmsAt(0.4);
  const late = rmsAt(1.3);
  if (early <= 1e-6) return false;
  // Less than 6dB lost over most of a second: still going, not decaying.
  return late / early > 0.5;
}

// ---- main ------------------------------------------------------------------

const soundfont = arg('--soundfont');
const out = arg('--out');
const work = join(tmpdir(), `measure-expression-${process.pid}`);
mkdirSync(work, { recursive: true });

try {
  const midiPath = join(work, 'probe.mid');
  const wavPath = join(work, 'probe.wav');
  writeFileSync(midiPath, buildProbeMidi());
  process.stdout.write('rendering 128 programs x 5 velocities... ');
  execFileSync('fluidsynth', ['-F', wavPath, '-ni', '-r', String(SAMPLE_RATE), '-g', '1', soundfont, midiPath], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const audio = readWavMono(wavPath);
  console.log(`${(audio.length / SAMPLE_RATE / 60).toFixed(1)} min of audio`);

  const table = {};
  let withFilter = 0;
  let slot = 0;
  for (let program = 0; program < 128; program += 1) {
    const spectra = new Map();
    let release = null;
    let sustains = false;
    for (const velocity of VELOCITIES) {
      const base = Math.round(slot * SLOT_SECONDS * SAMPLE_RATE);
      spectra.set(velocity, spectrum(audio, base + Math.round(ANALYSIS_OFFSET * SAMPLE_RATE)));
      if (velocity === 127) {
        release = measureRelease(audio, base + Math.round(HOLD_SECONDS * SAMPLE_RATE));
        sustains = measureSustain(audio, base);
      }
      slot += 1;
    }

    const loud = spectra.get(127);
    const cutoffs = {};
    for (const velocity of VELOCITIES) {
      if (velocity === 127) continue;
      const hz = cutoffBetween(loud, spectra.get(velocity));
      if (hz) cutoffs[velocity] = hz;
    }
    if (Object.keys(cutoffs).length > 0) withFilter += 1;
    table[program] = { cutoffs, releaseSec: release, sustains };
  }

  // Emitted as TypeScript, not JSON. A bare `import x from './x.json'` needs an
  // import attribute under Node ESM and is a bundler-specific favour everywhere
  // else; a plain module is understood by Metro, Node, Vite and tsc alike with
  // no conditions. The file is data either way.
  writeFileSync(
    out,
    [
      '/**',
      ' * Generated by `scripts/measure-expression.mjs` — do not edit.',
      ' *',
      ' * Per GM program: the low-pass corner at each probed velocity, the measured',
      ' * release, and whether the instrument holds its level while held.',
      ' * See `rn/playback/expression.ts` for what applies it.',
      ' */',
      'export type ExpressionEntry = {',
      '  cutoffs: Record<string, number>;',
      '  releaseSec: number | null;',
      '  sustains: boolean;',
      '};',
      '',
      `export const EXPRESSION_TABLE: Record<string, ExpressionEntry> = ${JSON.stringify(table, null, 1)};`,
      '',
    ].join('\n'),
  );
  console.log(`${withFilter}/128 instruments darken with velocity`);
  console.log(`${Object.values(table).filter((t) => t.sustains).length}/128 sustain while held (loopable past the 3.13s recording)`);
  const releases = Object.values(table).map((t) => t.releaseSec).filter((r) => r !== null);
  console.log(`release measured for ${releases.length}/128; median ${releases.sort((a, b) => a - b)[releases.length >> 1]}s`);
  console.log(`-> ${out} (${(readFileSync(out).length / 1024).toFixed(1)} KB)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
