#!/usr/bin/env node
/**
 * Renders the General MIDI drum kits out of a soundfont into sample packs.
 *
 * Why this script exists: Benjamin Gleitzman's pre-rendered FluidR3 packs, which
 * the RN engine uses for melodic instruments, are the **128 melodic programs
 * only**. There is no pre-rendered GM percussion anywhere with a licence this
 * project can use — the one collection that has it (WebAudioFont) is GPL-3.0.
 * So the drums are rendered here instead, from the same `FluidR3Mono_GM.sf3`
 * the web engine plays, which is CC-BY 3.0 and therefore may be redistributed
 * with attribution.
 *
 * The output is byte-for-byte the same shape as the melodic packs
 * (`MIDI.Soundfont.<name> = { "<note>": "data:audio/mp3;base64,..." }`), so
 * `sample-pack.ts` parses both with no special case.
 *
 * Usage:
 *   node scripts/build-percussion-packs.mjs \
 *     --soundfont ../music_app/public/audio/FluidR3Mono_GM.sf3 \
 *     --out ../music_app/public/audio/percussion
 *
 * Needs `fluidsynth` and `lame` on PATH. It is a build-time tool, run when the
 * font changes — not part of `bun run build`, because it takes minutes and its
 * output is an asset the app hosts rather than something this package ships.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** GM kits, mirroring `GM_KITS` in music_lib. Duplicated rather than imported: this is a standalone script and must run without a build. */
const KITS = [
  { program: 0, name: 'Standard Kit' },
  { program: 8, name: 'Room Kit' },
  { program: 16, name: 'Power Kit' },
  { program: 24, name: 'Electronic Kit' },
  { program: 25, name: 'TR-808 Kit' },
  { program: 32, name: 'Jazz Kit' },
  { program: 40, name: 'Brush Kit' },
  { program: 48, name: 'Orchestra Kit' },
];

/** GM percussion occupies 35..81. Matches `GM_PERCUSSION_RANGE` in music_lib. */
const FIRST_NOTE = 35;
const LAST_NOTE = 81;

const PPQ = 480;
/** Ticks between note starts. At 120bpm (500000us/qn) 480 ticks is 0.5s, so this is 4s — long enough for a ride or a crash to ring out. */
const SLOT_TICKS = PPQ * 8;
/** How long the key is held. Drums are one-shots; the gate length barely matters, but a real note-off keeps the file honest. */
const HOLD_TICKS = PPQ;
const SAMPLE_RATE = 44100;
/** Below this the tail is inaudible; trimming there is what keeps a kit under a megabyte. */
const SILENCE_FLOOR = 40 / 32768;
/** Kept after the last audible sample so a decay is not cut off abruptly. */
const TAIL_SECONDS = 0.05;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function noteName(midi) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required argument ${flag}`);
  }
  return process.argv[i + 1];
}

// ---- MIDI ------------------------------------------------------------------

function vlq(n) {
  const out = [n & 0x7f];
  let rest = n >>> 7;
  while (rest > 0) {
    out.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return out;
}

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** One format-0 file sounding every drum in `notes` on channel 10, spaced a slot apart. */
function buildKitMidi(program, notes) {
  const events = [...vlq(0), 0xc9, program];
  let sincePrevious = 0;
  for (const note of notes) {
    events.push(...vlq(sincePrevious), 0x99, note, 127);
    events.push(...vlq(HOLD_TICKS), 0x89, note, 0);
    sincePrevious = SLOT_TICKS - HOLD_TICKS;
  }
  events.push(...vlq(SLOT_TICKS), 0xff, 0x2f, 0x00);
  return Buffer.from([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (PPQ >> 8) & 255, PPQ & 255,
    0x4d, 0x54, 0x72, 0x6b, ...u32(events.length), ...events,
  ]);
}

// ---- WAV -------------------------------------------------------------------

/** Reads a 16-bit PCM wav into mono float samples. Chunks are walked rather than assumed at fixed offsets. */
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
  if (!pcm) throw new Error(`No data chunk in ${path}`);

  const frames = Math.floor(pcm.length / 2 / channels);
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += pcm.readInt16LE((frame * channels + c) * 2) / 32768;
    mono[frame] = sum / channels;
  }
  return mono;
}

function writeMonoWav(path, samples) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length * 2, 40);

  const body = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    body.writeInt16LE(Math.max(-1, Math.min(1, samples[i])) * 32767, i * 2);
  }
  writeFileSync(path, Buffer.concat([header, body]));
}

/** Cuts the slice at its last audible sample, so a kit is not mostly silence. */
function trimTail(samples) {
  let last = samples.length - 1;
  while (last > 0 && Math.abs(samples[last]) < SILENCE_FLOOR) last -= 1;
  if (last <= 0) return null; // this kit does not define this note
  return samples.subarray(0, Math.min(samples.length, last + Math.floor(TAIL_SECONDS * SAMPLE_RATE)));
}

// ---- main ------------------------------------------------------------------

const soundfont = arg('--soundfont');
const outDir = arg('--out');
const work = join(tmpdir(), `percussion-packs-${process.pid}`);
mkdirSync(work, { recursive: true });
mkdirSync(outDir, { recursive: true });

const notes = [];
for (let n = FIRST_NOTE; n <= LAST_NOTE; n += 1) notes.push(n);

const manifest = [];
try {
  for (const kit of KITS) {
    const midiPath = join(work, `kit-${kit.program}.mid`);
    const wavPath = join(work, `kit-${kit.program}.wav`);
    writeFileSync(midiPath, buildKitMidi(kit.program, notes));

    // One render per kit rather than one per note: the font takes seconds to
    // load and doing that 376 times instead of 8 is the difference between
    // minutes and most of an hour.
    execFileSync('fluidsynth', ['-F', wavPath, '-ni', '-r', String(SAMPLE_RATE), '-g', '1', soundfont, midiPath], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    const rendered = readWavMono(wavPath);
    const slotFrames = Math.round((SLOT_TICKS / PPQ) * 0.5 * SAMPLE_RATE);
    const entries = [];
    let kept = 0;

    for (let i = 0; i < notes.length; i += 1) {
      const start = i * slotFrames;
      const slice = trimTail(rendered.subarray(start, start + slotFrames));
      if (!slice) continue;

      const sliceWav = join(work, 'slice.wav');
      const sliceMp3 = join(work, 'slice.mp3');
      writeMonoWav(sliceWav, slice);
      execFileSync('lame', ['--quiet', '-m', 'm', '-b', '128', sliceWav, sliceMp3], { stdio: 'inherit' });
      const base64 = readFileSync(sliceMp3).toString('base64');
      entries.push(`"${noteName(notes[i])}": "data:audio/mp3;base64,${base64}"`);
      kept += 1;
    }

    const packName = `percussion_${kit.program}`;
    const body = [
      `if (typeof(MIDI) === 'undefined') var MIDI = {};`,
      `if (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};`,
      `MIDI.Soundfont.${packName} = {`,
      entries.join(',\n'),
      `}`,
      '',
    ].join('\n');
    const file = join(outDir, `${packName}-mp3.js`);
    writeFileSync(file, body);
    manifest.push(packName);
    console.log(`${kit.name.padEnd(16)} -> ${packName}-mp3.js  ${kept} drums, ${(body.length / 1024).toFixed(0)} KB`);
  }

  // The hash pins these renderings to the font they came from. Without it a
  // swapped soundfont leaves eight kits describing drums nobody is playing, and
  // nothing anywhere reports a problem.
  writeFileSync(
    join(outDir, 'names.json'),
    `${JSON.stringify({ soundfontSha256: createHash('sha256').update(readFileSync(soundfont)).digest('hex'), packs: manifest }, null, 2)}\n`,
  );
  writeFileSync(
    join(outDir, 'ATTRIBUTION.md'),
    [
      '# Percussion sample packs',
      '',
      'Rendered from **FluidR3Mono_GM.sf3** with `fluidsynth`, by',
      '`music_io/scripts/build-percussion-packs.mjs`.',
      '',
      'FluidR3 is distributed under Creative Commons Attribution 3.0.',
      'Original soundfont by Frank Wen. Redistribution of these renderings is',
      'permitted under that licence, with attribution.',
      '',
      'One file per General MIDI drum kit, named by the program that selects it',
      '(`percussion_0` is the Standard Kit, `percussion_25` the TR-808, and so on).',
      'Each holds the GM percussion range, MIDI notes 35-81, as base64 mp3 keyed by',
      'note name — the same format as the melodic packs, so one parser reads both.',
      '',
    ].join('\n'),
  );
  console.log(`\nmanifest + attribution written to ${outDir}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
