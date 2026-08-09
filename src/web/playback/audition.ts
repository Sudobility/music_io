/**
 * Auditioning: sounding a pitch *now*, for as long as it is held, so a player
 * can hear what a key does while editing.
 *
 * Deliberately separate from the transport. `play` renders the written score
 * along a timeline; this answers a different question and must never touch
 * transport state, move the caret, or join the active-note highlighting.
 */
import * as Tone from 'tone';
import { createInstrument } from './instruments/index.js';
import type { InstrumentHandle } from './instruments/index.js';

/** Auditioned notes sound at a fixed mezzo-forte; a tap carries no velocity. */
const AUDITION_VELOCITY = 0.8;
/** How long a struck voice rings when auditioned, since it cannot be held. */
const AUDITION_STRUCK_SECONDS = 0.4;

export class AuditionVoices {
  /**
   * Voices used only for auditioning, one per sound.
   *
   * Keyed by program *and* percussion: a drum track and a piano track can both
   * carry program 0, and sharing one voice would give whichever was tapped
   * first to the other.
   */
  private voices = new Map<string, InstrumentHandle>();
  /** Which voice is holding each sounding pitch, so `noteOff` can release it. */
  private held = new Map<number, InstrumentHandle>();

  /** Sounds `midi` and holds it. `destination` is the node to play into. */
  noteOn(midi: number, program: number, isPercussion: boolean, destination: Tone.ToneAudioNode | null): void {
    const key = `${program}:${isPercussion ? 'perc' : 'pitched'}`;
    let voice = this.voices.get(key);
    if (!voice) {
      voice = createInstrument(program, isPercussion);
      if (destination) voice.connect(destination);
      this.voices.set(key, voice);
    }

    // Retrigger cleanly if the same pitch is already held.
    this.held.get(midi)?.triggerRelease?.(midi);

    if (voice.triggerAttack) {
      voice.triggerAttack(midi, AUDITION_VELOCITY);
      this.held.set(midi, voice);
    } else {
      // A struck voice — a drum kit — has no sustain to hold, so it just sounds
      // once and there is nothing for noteOff to release.
      voice.triggerAttackRelease(midi, AUDITION_STRUCK_SECONDS, Tone.now(), AUDITION_VELOCITY);
    }
  }

  /** Releases a pitch started by `noteOn`. Silent no-op if it is not sounding. */
  noteOff(midi: number): void {
    const voice = this.held.get(midi);
    if (!voice) return;
    this.held.delete(midi);
    voice.triggerRelease?.(midi);
  }

  dispose(): void {
    for (const voice of this.voices.values()) voice.dispose();
    this.voices.clear();
    this.held.clear();
  }
}
