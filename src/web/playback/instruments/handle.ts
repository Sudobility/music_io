/**
 * The uniform voice contract the rest of playback schedules through, and the
 * adapters that make a Tone.js instrument satisfy it.
 *
 * Everything downstream — the engine, the offline renderer — only ever sees an
 * `InstrumentHandle`, so a family can be one synth, two crossfaded layers or a
 * ten-voice drum kit without any of them knowing.
 */
import * as Tone from 'tone';
import { midiToHertz } from '../midi.js';

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

// ---- pitched-voice wiring ---------------------------------------------------

/** The minimal shape every pitched Tone.js instrument used below satisfies. */
type PitchedVoice = Tone.ToneAudioNode & {
  triggerAttackRelease(note: number, duration: number, time?: number, velocity?: number): unknown;
  triggerAttack?(...args: never[]): unknown;
  triggerRelease?(...args: never[]): unknown;
};

export function wrapVoice(voice: PitchedVoice): InstrumentHandle {
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

/**
 * A millisecond: inaudible even on percussion, but enough to satisfy Tone's
 * strictly-increasing source-start assertion (see `monotonicTime`).
 */
const MONO_RETRIGGER_EPSILON_SECONDS = 0.001;

/**
 * Per-voice start-time monotonizer. Tone's single-source instruments
 * (`NoiseSynth`'s underlying `Noise`) assert that each `start(time)` is
 * STRICTLY greater than the previous one — but a real percussion track
 * routinely lands two hits on the same voice at the same tick (e.g. a closed
 * and a pedal hi-hat landing together, both on the closed-hat voice).
 * Untreated, the second `triggerAttackRelease` threw inside the Transport
 * callback, and that exception aborted the rest of the audio tick's event
 * batch — starving the position ticker (frozen caret) mid-playback.
 * Nudging a colliding (or out-of-order) hit forward by half a millisecond
 * keeps the source legal and is inaudible.
 */
export function monotonicTime(): (time: number) => number {
  let last = Number.NEGATIVE_INFINITY;
  return (time) => {
    // Floor at `now` before comparing. Tone clamps a start time that has
    // already passed up to the current time, so a batch of events firing late
    // together — which is what happens whenever the main thread stalls briefly
    // — all collapse onto the same instant however far apart their nominal
    // times were. Tracking the nominal times alone therefore let collisions
    // through the guard and the assertion still fired.
    const earliest = Math.max(time, Tone.now());
    const t = earliest <= last ? last + MONO_RETRIGGER_EPSILON_SECONDS : earliest;
    last = t;
    return t;
  };
}
