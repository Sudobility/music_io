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
 * How far a hit may ever be nudged past the time it was written for.
 *
 * A hard bound, not a tuning knob: without one the nudges compound, and a voice
 * that falls far enough behind schedules its hits past the end of playback and
 * goes silent. Past this, the guard gives up and uses the written time — the
 * worst case is then one dropped note (Tone throws, the engine catches and logs
 * it), which is vastly better than a track that mutes itself. 25ms is about
 * where a late percussion hit stops being a flam and starts being wrong.
 */
const MAX_NUDGE_SECONDS = 0.025;

/**
 * Per-voice start-time monotonizer. Tone's single-source instruments
 * (`NoiseSynth`'s underlying `Noise`, `MembraneSynth`'s oscillator) assert that
 * each `start(time)` is STRICTLY greater than the previous one — but a real
 * percussion track routinely lands two hits on the same voice at the same tick
 * (a closed and a pedal hi-hat landing together, say). Untreated, the second
 * `triggerAttackRelease` threw inside the Transport callback, and that
 * exception aborted the rest of that audio tick's events — including the
 * position ticker, which froze the caret mid-playback.
 *
 * Two things this must NOT do, both learned the hard way:
 *
 * Do not measure "already passed" with `Tone.now()`. That is
 * `currentTime + lookAhead`, and a Transport callback's `time` falls *inside*
 * the lookahead window — so `now()` is routinely *ahead* of a perfectly
 * punctual hit. Flooring at it pushed every hit up to a lookahead late, and
 * because a batch of events fired together all read the same `now()`, every one
 * of them collided and took another epsilon. `last` then ran ahead of the clock
 * faster than the clock advanced, hits were scheduled further and further out,
 * and the voice went silent until something rebuilt it. `currentTime` is the
 * real "has this moment passed" threshold.
 *
 * Do not let the nudge compound without limit — see `MAX_NUDGE_SECONDS`.
 */
export function monotonicTime(): (time: number) => number {
  let last = Number.NEGATIVE_INFINITY;
  return (time) => {
    let currentTime = Number.NEGATIVE_INFINITY;
    try {
      currentTime = Tone.getContext().currentTime;
    } catch {
      // No clock (the test mock): the written time is the only truth available.
    }
    const earliest = Math.max(time, currentTime);
    const nudged = last + MONO_RETRIGGER_EPSILON_SECONDS;
    // Measured against `earliest`, not the written time: a batch that is
    // genuinely overdue is legitimately clamped to now, and must still be
    // allowed to nudge. What the cap catches is `last` having run *ahead* of
    // the real schedule — the runaway — and there it resets to `earliest`,
    // snapping the voice back to the clock.
    const t = earliest <= last && nudged - earliest <= MAX_NUDGE_SECONDS ? nudged : earliest;
    last = t;
    return t;
  };
}
