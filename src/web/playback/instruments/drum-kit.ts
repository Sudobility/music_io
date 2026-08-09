/**
 * The drum kit: one voice per percussion *behaviour*, and the GM key map that
 * routes notes to them.
 *
 * Its own module because it is the one family that is not a single synth — a
 * kit is ten instruments that happen to share a channel, and the routing table
 * is the interesting part.
 */
import * as Tone from 'tone';
import { midiToHertz } from '../midi.js';
import { monotonicTime } from './handle.js';
import type { InstrumentHandle } from './handle.js';

/**
 * Which kit voice each GM percussion note is struck on.
 *
 * The kit used to have three voices — kick, snare, and one 50ms noise tick for
 * *everything else*. That "everything else" is around thirty instruments: every
 * cymbal (a crash rings for seconds, and got 50ms), the pitched hand drums
 * (bongos, congas and timbales are membranes with a note, and got unpitched
 * noise), and the metallic ones (cowbell, triangle, agogo all ring). A drum
 * track's cymbals were effectively inaudible as cymbals.
 *
 * Numbers are the GM percussion key map (channel 10), which runs 35..81.
 * Anything outside it falls back to `shaker`, the most neutral short noise.
 */
type KitVoiceName = 'kick' | 'tom' | 'snare' | 'hatClosed' | 'hatOpen' | 'cymbal' | 'handDrum' | 'metallic' | 'wood' | 'shaker';

const KIT_ROUTING: Record<number, KitVoiceName> = {
  35: 'kick', // Acoustic Bass Drum
  36: 'kick', // Bass Drum 1
  37: 'snare', // Side Stick
  38: 'snare', // Acoustic Snare
  39: 'snare', // Hand Clap
  40: 'snare', // Electric Snare
  41: 'tom', // Low Floor Tom
  42: 'hatClosed', // Closed Hi-Hat
  43: 'tom', // High Floor Tom
  44: 'hatClosed', // Pedal Hi-Hat
  45: 'tom', // Low Tom
  46: 'hatOpen', // Open Hi-Hat — rings, unlike the closed one
  47: 'tom', // Low-Mid Tom
  48: 'tom', // Hi-Mid Tom
  49: 'cymbal', // Crash Cymbal 1
  50: 'tom', // High Tom
  51: 'cymbal', // Ride Cymbal 1
  52: 'cymbal', // Chinese Cymbal
  53: 'cymbal', // Ride Bell
  54: 'metallic', // Tambourine
  55: 'cymbal', // Splash Cymbal
  56: 'metallic', // Cowbell
  57: 'cymbal', // Crash Cymbal 2
  58: 'shaker', // Vibraslap
  59: 'cymbal', // Ride Cymbal 2
  60: 'handDrum', // Hi Bongo
  61: 'handDrum', // Low Bongo
  62: 'handDrum', // Mute Hi Conga
  63: 'handDrum', // Open Hi Conga
  64: 'handDrum', // Low Conga
  65: 'handDrum', // High Timbale
  66: 'handDrum', // Low Timbale
  67: 'metallic', // High Agogo
  68: 'metallic', // Low Agogo
  69: 'shaker', // Cabasa
  70: 'shaker', // Maracas
  71: 'shaker', // Short Whistle
  72: 'shaker', // Long Whistle
  73: 'shaker', // Short Guiro
  74: 'shaker', // Long Guiro
  75: 'wood', // Claves
  76: 'wood', // Hi Wood Block
  77: 'wood', // Low Wood Block
  78: 'handDrum', // Mute Cuica
  79: 'handDrum', // Open Cuica
  80: 'metallic', // Mute Triangle
  81: 'metallic', // Open Triangle
};


export function createDrumKitInstrument(): InstrumentHandle {
  const output = new Tone.Gain(1);

  /** Pitched membranes: kick, toms and the hand drums all have a note. */
  const kick = new Tone.MembraneSynth({ envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.4 } });
  const tom = new Tone.MembraneSynth({ envelope: { attack: 0.001, decay: 0.8, sustain: 0, release: 0.6 } });
  const handDrum = new Tone.MembraneSynth({
    octaves: 1.5, // less pitch sweep than a kick: a conga is struck, not boomed
    envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.3 },
  });

  /** Noise voices, each with its own colour and length. */
  const snare = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 },
  });
  const hatClosed = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
  });
  const hatOpen = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.2 },
  });
  const cymbal = new Tone.NoiseSynth({
    noise: { type: 'white' },
    // The long tail is the point: a crash rings for seconds.
    envelope: { attack: 0.001, decay: 2.2, sustain: 0, release: 1.5 },
  });
  const shaker = new Tone.NoiseSynth({
    noise: { type: 'pink' },
    envelope: { attack: 0.002, decay: 0.12, sustain: 0, release: 0.08 },
  });

  /** Metallic and wooden voices ring at a pitch, so they are FM rather than noise. */
  const metallic = new Tone.FMSynth({
    harmonicity: 5.1, // inharmonic, which is what makes metal read as metal
    modulationIndex: 12,
    envelope: { attack: 0.001, decay: 1.0, sustain: 0, release: 0.8 },
    modulationEnvelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.1 },
  });
  const wood = new Tone.FMSynth({
    harmonicity: 3.2,
    modulationIndex: 6,
    envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.06 },
    modulationEnvelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.03 },
  });

  // Each noise voice gets the filter that gives it its colour: hats and cymbals
  // are bright, a shaker sits a little lower.
  const hatClosedFilter = new Tone.Filter(7000, 'highpass');
  const hatOpenFilter = new Tone.Filter(7000, 'highpass');
  const cymbalFilter = new Tone.Filter(3000, 'highpass');
  const shakerFilter = new Tone.Filter(5000, 'highpass');
  hatClosed.connect(hatClosedFilter);
  hatOpen.connect(hatOpenFilter);
  cymbal.connect(cymbalFilter);
  shaker.connect(shakerFilter);

  /**
   * Internal kit balance, measured the same way the family trims are.
   *
   * Left alone, the cymbals and hats peaked *above* full scale on their own
   * (1.20 and 1.19) while a cowbell or woodblock reached 0.25 — a 13dB spread
   * with clipping at the loud end. A kit does want its drums louder than its
   * woodblock, but not by that, and not by clipping. These bring every voice
   * into a 0.55..0.80 peak band with the drums on top.
   */
  const voiceGain = {
    hatClosed: new Tone.Gain(0.55),
    hatOpen: new Tone.Gain(0.55),
    cymbal: new Tone.Gain(0.62),
    metallic: new Tone.Gain(2.4),
    wood: new Tone.Gain(2.4),
  };

  for (const node of [kick, tom, handDrum, snare]) node.connect(output);
  metallic.connect(voiceGain.metallic);
  wood.connect(voiceGain.wood);
  hatClosedFilter.connect(voiceGain.hatClosed);
  hatOpenFilter.connect(voiceGain.hatOpen);
  cymbalFilter.connect(voiceGain.cymbal);
  shakerFilter.connect(output);
  for (const g of Object.values(voiceGain)) g.connect(output);

  /** Every voice here is single-source, so each needs its own monotonizer. */
  const nudge: Record<KitVoiceName, (time: number) => number> = {
    kick: monotonicTime(),
    tom: monotonicTime(),
    handDrum: monotonicTime(),
    snare: monotonicTime(),
    hatClosed: monotonicTime(),
    hatOpen: monotonicTime(),
    cymbal: monotonicTime(),
    shaker: monotonicTime(),
    metallic: monotonicTime(),
    wood: monotonicTime(),
  };

  return {
    triggerAttackRelease(midi, durationSeconds, time, velocity) {
      const voice = KIT_ROUTING[midi] ?? 'shaker';
      const at = nudge[voice](time);
      switch (voice) {
        case 'kick':
          return kick.triggerAttackRelease(midiToHertz(midi), durationSeconds, at, velocity);
        case 'tom':
          return tom.triggerAttackRelease(midiToHertz(midi), durationSeconds, at, velocity);
        case 'handDrum':
          return handDrum.triggerAttackRelease(midiToHertz(midi), durationSeconds, at, velocity);
        case 'metallic':
          return metallic.triggerAttackRelease(midiToHertz(midi), durationSeconds, at, velocity);
        case 'wood':
          return wood.triggerAttackRelease(midiToHertz(midi), durationSeconds, at, velocity);
        case 'snare':
          return snare.triggerAttackRelease(durationSeconds, at, velocity);
        case 'hatClosed':
          return hatClosed.triggerAttackRelease(durationSeconds, at, velocity);
        case 'hatOpen':
          return hatOpen.triggerAttackRelease(durationSeconds, at, velocity);
        case 'cymbal':
          return cymbal.triggerAttackRelease(durationSeconds, at, velocity);
        case 'shaker':
          return shaker.triggerAttackRelease(durationSeconds, at, velocity);
      }
    },
    connect(node) {
      output.connect(node);
    },
    dispose() {
      for (const n of [kick, tom, handDrum, snare, hatClosed, hatOpen, cymbal, shaker, metallic, wood]) n.dispose();
      for (const n of [hatClosedFilter, hatOpenFilter, cymbalFilter, shakerFilter]) n.dispose();
      for (const g of Object.values(voiceGain)) g.dispose();
      output.dispose();
    },
  };
}
