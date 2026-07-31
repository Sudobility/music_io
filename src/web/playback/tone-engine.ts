/**
 * `TonePlaybackEngine` (spec §10, Task 13 brief): the concrete
 * `PlaybackEngine` implementation over Tone.js. `services/playback/
 * controller.ts` is the only intended caller — it owns the singleton
 * instance and bridges it to the Zustand store; nothing here touches
 * Zustand.
 *
 * ---- Timing model ----------------------------------------------------
 *
 * `Tone.getTransport().bpm` is pinned to a fixed `BASE_BPM` (60) by
 * `ensureBaseBpm()` before every batch of Transport scheduling (and in
 * `initialize()`), and never set to anything else. Our own domain `TempoMap`
 * (built from the score's own tempo curve) is the sole authority for
 * "what second does score-tick T fall at" via `ticksToSeconds` — that
 * "logical second" is what gets divided by `tempoMultiplier` before being
 * handed to any Tone time-accepting API (`schedule`, `loopStart`/
 * `loopEnd`, `seconds`). Every one of those conversions therefore always
 * happens under the same fixed bpm=60 basis, so they're consistent with
 * each other regardless of when they're called.
 *
 * The consequence: changing `tempoMultiplier` changes what real-world
 * second each already-known score-tick maps to, so it requires actually
 * re-scheduling (there is no free "speed knob" on the already-scheduled
 * events) — `setTempoMultiplier` does that in place (cancel + reschedule +
 * re-seek to the equivalent position), without stopping the Transport
 * clock, so a live speed change doesn't restart playback from the top.
 * (An alternative considered: leave scheduled seconds alone and instead
 * scale `Transport.bpm.value` at runtime — Tone does internally store
 * scheduled times as ticks, so this works, but it entangles our own
 * TempoMap-driven seconds with Tone's independent tick/bpm bookkeeping in
 * a way that's harder to reason about and to unit test through a mocked
 * `tone` module. Dividing our own seconds keeps one single source of
 * truth for "seconds" and reuses the exact same reschedule machinery
 * score edits already need.)
 *
 * ---- No stuck notes ----------------------------------------------------
 *
 * `InstrumentHandle` (adapters/tone/instruments.ts) intentionally exposes
 * no "release everything now" method. Instead, every place that needs to
 * guarantee silence (`pause`, `stop`, `seek`, and the rebuild
 * `setTempoMultiplier` needs) disposes every track's instrument and
 * rebuilds it fresh (`rebuildChannels`) — disposing the underlying Tone
 * nodes is the one operation guaranteed to stop sound regardless of which
 * of the instrument categories (mono/poly/AM/FM/noise/membrane) is playing.
 * Recreating a handful of synth nodes is cheap, so this trades a small
 * amount of overhead for a simple, uniform correctness guarantee.
 */
import * as Tone from 'tone';
import { TempoMap } from '../../domain/time/tempo-map.js';
import type { Score } from '@sudobility/music_types';
import type { ScoreRange } from '../../domain/selection/types.js';
import { createInstrument } from './instruments.js';
import type { InstrumentHandle } from './instruments.js';
import { flattenScoreForPlayback, metronomeClicks } from './schedule.js';
import type { ScheduledNote } from './schedule.js';
import { normalizeVelocity } from './midi.js';
import { scoreEndTick } from '../../domain/score/queries.js';
import type { PlaybackEngine, PlaybackObserver } from '../../services/playback/types.js';

const BASE_BPM = 60;
const POSITION_TICK_INTERVAL_SECONDS = 1 / 30;
const MIN_NOTE_DURATION_SECONDS = 0.01;
/** How far past the score's final tick the auto-stop fires — after the last note-offs scheduled at exactly the end, and far enough that float rounding in seconds conversion can't order it before them. */
const END_OF_SCORE_STOP_EPSILON_SECONDS = 0.05;
const METRONOME_ACCENT_HZ = 1500;
const METRONOME_BEAT_HZ = 1000;
const METRONOME_CLICK_SECONDS = 0.03;

type TrackChannel = {
  instrument: InstrumentHandle;
  panner: Tone.Panner;
  gain: Tone.Gain;
  /** Runtime (possibly live-overridden — see `setTrackMute`/`setTrackSolo`) mute/solo/volume, seeded from `Track` on a genuine `loadScore` reload. */
  muted: boolean;
  solo: boolean;
  volume: number;
};

export class TonePlaybackEngine implements PlaybackEngine {
  private score: Score | null = null;
  private tempoMap: TempoMap = new TempoMap([], 480);
  private scheduledNotes: ScheduledNote[] = [];
  private channels = new Map<string, TrackChannel>();
  private observer: PlaybackObserver | null = null;

  private tempoMultiplier = 1;
  private loopRange: ScoreRange | null = null;
  private metronomeEnabled = false;
  private masterVolume = 1;

  private masterGain: Tone.Gain | null = null;
  private metronomeSynth: Tone.Synth | null = null;
  /** Ids of the schedule()/scheduleRepeat() calls that make up note playback + the position ticker; all cleared/rebuilt together (`scheduleAll`). */
  private noteEventIds: number[] = [];
  /** Metronome click ids, tracked separately so toggling the metronome never disturbs note scheduling. */
  private metronomeEventIds: number[] = [];
  private activeNoteIds = new Set<string>();

  private initialized = false;
  private visibilityHandler: (() => void) | null = null;
  /**
   * Bumped by every `stop()`/`pause()`/`dispose()` call, and captured by
   * `play()` before its `await this.initialize()` (the first call's real
   * async `Tone.start()` — an AudioContext resume that can take a
   * noticeable moment). Without this, a `stop()` issued while that await is
   * in flight would complete synchronously, and then `play()`'s
   * continuation would go on to unconditionally call `transport.start()`
   * once the await resolves — silently overriding the stop. `play()`
   * re-checks the generation immediately after the await and aborts if it
   * changed.
   */
  private generation = 0;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await Tone.start();
    this.ensureBaseBpm();
    this.ensureMasterGain();
    this.attachVisibilityHandler();
    this.initialized = true;
  }

  async loadScore(score: Score): Promise<void> {
    this.score = score;
    this.tempoMap = new TempoMap(score.tempoMap, score.ppq);
    this.scheduledNotes = flattenScoreForPlayback(score);
    this.rebuildChannels(true);
    this.scheduleAll();
  }

  async play(fromTick?: number): Promise<void> {
    if (!this.score) return;
    const generation = this.generation;
    await this.initialize();
    if (generation !== this.generation) return; // a stop()/pause()/dispose() happened while we awaited initialize(); it wins.
    const transport = Tone.getTransport();
    if (fromTick !== undefined) {
      transport.seconds = this.scheduledSeconds(fromTick);
    }
    transport.start();
    this.observer?.onStateChange('playing');
  }

  pause(): void {
    this.generation++;
    const transport = Tone.getTransport();
    transport.pause();
    this.silenceAndReschedule(); // see silenceAndReschedule's doc: rebuildChannels alone would leave already-scheduled note-on callbacks pointing at disposed instruments
    this.observer?.onStateChange('paused');
  }

  stop(): void {
    this.generation++;
    const transport = Tone.getTransport();
    transport.stop();
    transport.seconds = 0;
    this.activeNoteIds.clear();
    this.silenceAndReschedule(); // ready for the next play() with no further loadScore() needed
    this.observer?.onActiveNotes([]);
    this.observer?.onPositionTick(0);
    this.observer?.onStateChange('stopped');
  }

  seek(tick: number): void {
    if (!this.score) return;
    this.silenceAndReschedule(); // silence anything currently sounding before jumping
    Tone.getTransport().seconds = this.scheduledSeconds(tick);
    this.observer?.onPositionTick(tick);
  }

  setTempoMultiplier(multiplier: number): void {
    const transport = Tone.getTransport();
    const wasPlaying = transport.state === 'started';
    const currentTick = this.currentPositionTick(); // computed under the *old* multiplier, before it changes below
    this.tempoMultiplier = multiplier;
    if (!this.score) return;

    this.silenceAndReschedule();
    transport.seconds = this.scheduledSeconds(currentTick);
    if (wasPlaying && (transport.state as string) !== 'started') {
      transport.start();
    }
  }

  setLoop(range: ScoreRange | null): void {
    this.loopRange = range;
    this.applyLoop();
  }

  setTrackMute(trackId: string, muted: boolean): void {
    const channel = this.channels.get(trackId);
    if (!channel) return;
    channel.muted = muted;
    this.applyChannelGains();
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    const channel = this.channels.get(trackId);
    if (!channel) return;
    channel.solo = solo;
    this.applyChannelGains();
  }

  setMetronome(enabled: boolean): void {
    this.metronomeEnabled = enabled;
    this.rescheduleMetronome();
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = volume;
    if (this.masterGain) this.masterGain.gain.value = volume;
  }

  setObserver(observer: PlaybackObserver | null): void {
    this.observer = observer;
  }

  dispose(): void {
    this.generation++;
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel(0);
    this.noteEventIds = [];
    this.metronomeEventIds = [];

    for (const channel of this.channels.values()) {
      channel.instrument.dispose();
      channel.panner.dispose();
      channel.gain.dispose();
    }
    this.channels.clear();

    this.metronomeSynth?.dispose();
    this.metronomeSynth = null;
    this.masterGain?.dispose();
    this.masterGain = null;

    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.visibilityHandler = null;

    this.observer = null;
    this.score = null;
    this.activeNoteIds.clear();
    this.initialized = false;
  }

  // ---- internals ------------------------------------------------------

  /**
   * Pins Transport bpm to `BASE_BPM` — and MUST run before ANY call that
   * hands the Transport a time (`schedule`, `scheduleRepeat`, `seconds =`,
   * `loopStart`/`loopEnd`): Tone converts those seconds to internal ticks
   * at the bpm current at that moment, so anything scheduled under the
   * default bpm (120) fires at the wrong real time once bpm becomes 60.
   * That happened in practice: `loadScore()` runs on project load, before
   * the first `play()` ever calls `initialize()` — every note landed at 2x
   * its intended second while the position ticker (which reads live
   * `transport.seconds`) stayed correct, so the caret ran exactly twice as
   * fast as the audio. Setting `bpm.value` needs no `Tone.start()`, so
   * this is safe pre-initialize.
   */
  private ensureBaseBpm(): void {
    const bpm = Tone.getTransport().bpm;
    if (bpm.value !== BASE_BPM) bpm.value = BASE_BPM;
  }

  private ensureMasterGain(): Tone.Gain {
    if (!this.masterGain) {
      this.masterGain = new Tone.Gain(this.masterVolume).toDestination();
    }
    return this.masterGain;
  }

  private attachVisibilityHandler(): void {
    if (typeof document === 'undefined' || this.visibilityHandler) return;
    this.visibilityHandler = () => {
      if (document.hidden && Tone.getTransport().state === 'started') {
        this.pause();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  /** A domain score-tick's playback position in Transport seconds, under the current `tempoMultiplier`. */
  private scheduledSeconds(tick: number): number {
    return this.tempoMap.ticksToSeconds(tick) / this.tempoMultiplier;
  }

  /** The domain score-tick the Transport's current (real) position corresponds to, under the current `tempoMultiplier`. */
  private currentPositionTick(): number {
    const transport = Tone.getTransport();
    return Math.max(0, Math.round(this.tempoMap.secondsToTicks(transport.seconds * this.tempoMultiplier)));
  }

  /**
   * Silences everything currently sounding and re-establishes the note/
   * metronome/position-ticker/loop schedule. `rebuildChannels` alone is
   * not enough: it disposes and *replaces* every `TrackChannel` (a fresh
   * `Map`), but every not-yet-fired `transport.schedule` callback already
   * created by an earlier `scheduleAll()` closed over the *old*
   * `TrackChannel` object (captured by reference at scheduling time) —
   * left alone, those callbacks would go on calling `triggerAttackRelease`
   * on a now-disposed instrument when their time comes, producing no
   * sound at all for every note after this point. Re-running
   * `scheduleAll()` immediately after `rebuildChannels` closes over the
   * *new* channels instead. This is safe to do at any transport state
   * (including while paused) because every scheduled time is an absolute
   * score-relative second, not relative to "now".
   */
  private silenceAndReschedule(): void {
    this.rebuildChannels(false);
    this.scheduleAll();
  }

  /**
   * Tears down and recreates every track's instrument/panner/gain nodes
   * (see class doc's "No stuck notes"). When `reseedFromScore` is true
   * (a genuine `loadScore`), each channel's mute/solo/volume is read fresh
   * from `Track`; otherwise (silencing for pause/stop/seek/tempo-change)
   * the previous *runtime* mute/solo/volume is preserved, so a live-only
   * `setTrackMute`/`setTrackSolo` override (not yet persisted to the score
   * — that's the UI's job, not this engine's) survives across it.
   */
  private rebuildChannels(reseedFromScore: boolean): void {
    const previous = this.channels;
    for (const channel of previous.values()) {
      channel.instrument.dispose();
      channel.panner.dispose();
      channel.gain.dispose();
    }
    this.channels = new Map();
    if (!this.score) return;

    const master = this.ensureMasterGain();
    for (const track of this.score.tracks) {
      const runtime = !reseedFromScore ? previous.get(track.id) : undefined;
      const instrument = createInstrument(track.instrumentName || track.midiProgram, track.clef === 'percussion');
      const panner = new Tone.Panner(track.pan);
      const gain = new Tone.Gain(1);
      instrument.connect(panner);
      panner.connect(gain);
      gain.connect(master);

      this.channels.set(track.id, {
        instrument,
        panner,
        gain,
        muted: runtime?.muted ?? track.muted,
        solo: runtime?.solo ?? track.solo,
        volume: runtime?.volume ?? track.volume,
      });
    }
    this.applyChannelGains();
  }

  /** Applies spec §10 mute/solo semantics: if any track is soloed, only soloed tracks are audible; otherwise every non-muted track is. */
  private applyChannelGains(): void {
    const anySolo = Array.from(this.channels.values()).some((c) => c.solo);
    for (const channel of this.channels.values()) {
      const audible = anySolo ? channel.solo : !channel.muted;
      channel.gain.gain.value = audible ? channel.volume : 0;
    }
  }

  /** (Re)schedules every note-on/off callback and the position ticker. Always starts by cancelling every previously-scheduled event (spec: "reschedule safely after edits"). */
  private scheduleAll(): void {
    this.ensureBaseBpm(); // before ANY schedule call — see ensureBaseBpm's doc
    const transport = Tone.getTransport();
    transport.cancel(0);
    this.noteEventIds = [];

    for (const note of this.scheduledNotes) {
      const channel = this.channels.get(note.trackId);
      if (!channel) continue;

      const startSeconds = this.scheduledSeconds(note.tick);
      const endSeconds = this.scheduledSeconds(note.tick + note.durTicks);
      const durationSeconds = Math.max(endSeconds - startSeconds, MIN_NOTE_DURATION_SECONDS);
      const velocity = normalizeVelocity(note.velocity);

      const onId = transport.schedule((time) => {
        // One bad note must never abort the Transport's event batch: an
        // exception thrown from inside a Transport callback stops Tone from
        // processing the REST of that audio tick's events — including the
        // position ticker — which froze the caret mid-playback while
        // already-processed notes kept sounding. (Seen in practice with the
        // drum kit's mono NoiseSynth voices; see instruments.ts's
        // monotonicTime for the trigger-level fix.)
        try {
          channel.instrument.triggerAttackRelease(note.midi, durationSeconds, time, velocity);
        } catch (error) {
          console.error('TonePlaybackEngine: note trigger failed', note.noteId, error);
        }
        this.noteOn(note.noteId);
      }, startSeconds);
      const offId = transport.schedule(() => {
        this.noteOff(note.noteId);
      }, endSeconds);
      this.noteEventIds.push(onId, offId);
    }

    // End-of-score auto-stop: the Transport has no notion of "the score is
    // over", so without this it keeps running (position ticking past the
    // last note forever) until the user presses Stop. Scheduled alongside
    // the note events so every reschedule path rebuilds it. Inert while a
    // loop is active — the Transport wraps at loopEnd and never reaches
    // this — but a loop can also be cleared mid-playback, so the guard is
    // re-checked at fire time rather than baked in at schedule time.
    if (this.score) {
      const endSeconds = this.scheduledSeconds(scoreEndTick(this.score));
      const endId = transport.schedule(() => {
        if (this.loopRange) return;
        this.stop();
      }, endSeconds + END_OF_SCORE_STOP_EPSILON_SECONDS);
      this.noteEventIds.push(endId);
    }

    this.schedulePositionTicker();
    this.rescheduleMetronome();
    this.applyLoop();
  }

  private schedulePositionTicker(): void {
    const transport = Tone.getTransport();
    const id = transport.scheduleRepeat(() => {
      const tick = this.tempoMap.secondsToTicks(transport.seconds * this.tempoMultiplier);
      this.observer?.onPositionTick(Math.max(0, Math.round(tick)));
    }, POSITION_TICK_INTERVAL_SECONDS);
    this.noteEventIds.push(id);
  }

  private rescheduleMetronome(): void {
    const transport = Tone.getTransport();
    for (const id of this.metronomeEventIds) transport.clear(id);
    this.metronomeEventIds = [];
    if (!this.metronomeEnabled || !this.score) return;

    for (const click of metronomeClicks(this.score)) {
      const seconds = this.scheduledSeconds(click.tick);
      const id = transport.schedule((time) => {
        const frequency = click.accent ? METRONOME_ACCENT_HZ : METRONOME_BEAT_HZ;
        this.ensureMetronomeSynth().triggerAttackRelease(frequency, METRONOME_CLICK_SECONDS, time);
      }, seconds);
      this.metronomeEventIds.push(id);
    }
  }

  private ensureMetronomeSynth(): Tone.Synth {
    if (!this.metronomeSynth) {
      this.metronomeSynth = new Tone.Synth({
        envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
      }).toDestination();
    }
    return this.metronomeSynth;
  }

  private applyLoop(): void {
    this.ensureBaseBpm(); // loopStart/loopEnd are bpm-converted too, and setLoop() can run pre-initialize
    const transport = Tone.getTransport();
    if (!this.loopRange) {
      transport.loop = false;
      return;
    }
    transport.loopStart = this.scheduledSeconds(this.loopRange.startTick);
    transport.loopEnd = this.scheduledSeconds(this.loopRange.endTick);
    transport.loop = true;
  }

  private noteOn(noteId: string): void {
    this.activeNoteIds.add(noteId);
    this.observer?.onActiveNotes(Array.from(this.activeNoteIds));
  }

  private noteOff(noteId: string): void {
    this.activeNoteIds.delete(noteId);
    this.observer?.onActiveNotes(Array.from(this.activeNoteIds));
  }
}
