/**
 * Pure score -> playback-schedule flattening (Task 13 brief). No Tone.js
 * import: this is exactly the "logic that doesn't need Tone" the brief
 * asks to keep separately testable, so `tone-engine.test.ts`'s mocked-`tone`
 * surface stays small. `tone-engine.ts` is the only caller.
 */
import { isNoteEvent } from '@sudobility/music_types';
import type { MusicalEvent, Score, Track } from '@sudobility/music_types';
import { joinTiedNotes } from '../../domain/score/ties.js';
import { pitchToMidi } from '../../domain/pitch/pitch.js';
import { beatBoundaries } from '../../domain/time/ticks.js';

/** One playback-ready note: absolute score-tick position/duration, resolved MIDI pitch, and provenance (for mute/solo routing and active-note highlighting). */
export type ScheduledNote = {
  tick: number;
  durTicks: number;
  midi: number;
  velocity: number;
  trackId: string;
  noteId: string;
};

/**
 * Every voice-ordinal "channel" of `track`: the concatenation, across all
 * of its measures in tick order, of the events belonging to the voice at
 * that ordinal position (measure.voices[i]). This mirrors
 * `domain/score/ties.ts`'s own private `voiceChannel` helper (same
 * rationale: voice ids aren't stable across a barline per spec §25, so a
 * voice's ordinal position stands in for "the same voice" from one measure
 * to the next) — reimplemented here rather than imported because ties.ts
 * doesn't export it, to avoid coupling this adapter's scheduling concerns
 * to a domain module's private helper.
 */
function trackVoiceChannels(track: Track): MusicalEvent[][] {
  const maxVoices = track.measures.reduce((max, measure) => Math.max(max, measure.voices.length), 0);
  const channels: MusicalEvent[][] = [];
  for (let voiceIndex = 0; voiceIndex < maxVoices; voiceIndex += 1) {
    const channel: MusicalEvent[] = [];
    for (const measure of track.measures) {
      const voice = measure.voices[voiceIndex];
      if (voice) channel.push(...voice.events);
    }
    channel.sort((a, b) => a.startTick - b.startTick);
    channels.push(channel);
  }
  return channels;
}

/**
 * Flattens every track's notes into playback-ready events (spec §10):
 * within each voice-channel, tied notes are joined into one sustained note
 * spanning their combined duration via `domain/score/ties.ts`'s
 * `joinTiedNotes` (the tie-continuation note is merged away entirely, never
 * separately scheduled — "skipping tie-continuation notes" per the Task 13
 * brief). Rests are dropped (nothing to schedule). Result is sorted by
 * `tick` ascending.
 */
export function flattenScoreForPlayback(score: Score): ScheduledNote[] {
  const result: ScheduledNote[] = [];
  for (const track of score.tracks) {
    for (const channel of trackVoiceChannels(track)) {
      for (const event of joinTiedNotes(channel)) {
        if (!isNoteEvent(event)) continue;
        result.push({
          tick: event.startTick,
          durTicks: event.durationTicks,
          midi: pitchToMidi(event.pitch),
          velocity: event.velocity,
          trackId: track.id,
          noteId: event.id,
        });
      }
    }
  }
  return result.sort((a, b) => a.tick - b.tick);
}

/** One metronome click position: `accent` marks beat 1 of its measure (spec §22 implies a distinguishable downbeat). */
export type MetronomeClick = { tick: number; accent: boolean };

/**
 * Every beat position across the score's measure grid (spec §22
 * "metronome toggle"), read off the score's first track — every track
 * shares the same measure grid once `rebuildMeasureTicks` has run (see
 * `domain/score/factory.ts`), the same convention `store/selectors.ts`'s
 * `selectCurrentMeasureBeat` uses. Empty if the score has no tracks.
 */
export function metronomeClicks(score: Score): MetronomeClick[] {
  const track = score.tracks[0];
  if (!track) return [];
  const clicks: MetronomeClick[] = [];
  for (const measure of track.measures) {
    const boundaries = beatBoundaries(measure.timeSignature, score.ppq);
    boundaries.forEach((offset, i) => {
      clicks.push({ tick: measure.startTick + offset, accent: i === 0 });
    });
  }
  return clicks;
}
