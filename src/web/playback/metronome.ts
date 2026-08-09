/**
 * The metronome click (spec §22).
 *
 * Kept apart from note scheduling because the two must not disturb each other:
 * toggling the click mid-playback reschedules only these events, and a score
 * edit reschedules only the notes. That is why the ids are tracked separately
 * from `noteEventIds` in the engine.
 *
 * It plays straight to the destination rather than through the mixer — a click
 * is a monitoring aid, not part of the music, so the master headroom trim and
 * per-track balance have no business changing how loud it is.
 */
import * as Tone from 'tone';
import type { Score } from '@sudobility/music_types';
import { metronomeClicks } from './schedule.js';

const ACCENT_HZ = 1500;
const BEAT_HZ = 1000;
const CLICK_SECONDS = 0.03;

export class Metronome {
  private synth: Tone.Synth | null = null;
  private eventIds: number[] = [];
  private enabled = false;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Clears and rebuilds the click schedule. `secondsFor` converts a score tick
   * to Transport seconds — the engine owns that conversion, because it depends
   * on the tempo map and the playback-speed multiplier.
   */
  reschedule(score: Score | null, secondsFor: (tick: number) => number): void {
    const transport = Tone.getTransport();
    for (const id of this.eventIds) transport.clear(id);
    this.eventIds = [];
    if (!this.enabled || !score) return;

    for (const click of metronomeClicks(score)) {
      const id = transport.schedule((time) => {
        const frequency = click.accent ? ACCENT_HZ : BEAT_HZ;
        this.ensureSynth().triggerAttackRelease(frequency, CLICK_SECONDS, time);
      }, secondsFor(click.tick));
      this.eventIds.push(id);
    }
  }

  private ensureSynth(): Tone.Synth {
    if (!this.synth) {
      this.synth = new Tone.Synth({
        envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
      }).toDestination();
    }
    return this.synth;
  }

  /** Forgets the scheduled ids without clearing them: the caller cancels the whole transport. */
  forgetSchedule(): void {
    this.eventIds = [];
  }

  dispose(): void {
    this.synth?.dispose();
    this.synth = null;
    this.eventIds = [];
  }
}
