/**
 * `PlaybackEngine` over a worklet-hosted soundfont synth.
 *
 * The shape is: a note queue with a cursor, a clock we own, and a pump that
 * drains a lookahead window and hands the due notes to the synth. Voice
 * allocation and stealing belong to fluidsynth, which is the point — every
 * note-loss bug in the engine this replaces came from our own voice management
 * refusing a note.
 *
 * Everything time-related is injected (`now`, `startPump`, `createContext`,
 * `loadFont`) so the transport can be tested without an audio device or real
 * time. The alternative is an engine verifiable only by ear, which is how the
 * last one accumulated four silent-failure bugs.
 */
import { TempoMap } from '@sudobility/music_lib';
import type { PlaybackEngine, PlaybackObserver, Score, ScoreRange } from '@sudobility/music_types';
import { allocateChannels } from './channel-allocator.js';
import type { ChannelAssignment } from './channel-allocator.js';
import { PlaybackClock } from './clock.js';
import { NoteQueue } from './note-queue.js';
import { planDispatch } from './pump-window.js';
import { scheduleClick } from './click.js';
import { Governor } from './governor.js';
import { flattenScoreForPlayback, metronomeClicks } from './schedule.js';
import { loadSoundfont, openSoundfontCache } from './soundfont-loader.js';

/** The slice of `SynthHost` this engine drives, so tests can pass a stub. */
export type SynthHostLike = {
  init(
    context: BaseAudioContext,
    options: {
      fluidsynthModuleUrl: string;
      workletModuleUrl: string;
      soundfont: ArrayBuffer;
      instanceCount: number;
    },
  ): Promise<void>;
  setChannelPercussion(instance: number, channel: number): void;
  programSelect(instance: number, channel: number, program: number): void;
  noteOn(instance: number, channel: number, midi: number, velocity: number): void;
  noteOff(instance: number, channel: number, midi: number): void;
  controlChange(instance: number, channel: number, control: number, value: number): void;
  allSoundOff(): void;
  setInterpolation(order: number): void;
  setMasterVolume(volume: number): void;
  setTrackCount(count: number): void;
  dispose(): void;
};

export type SoundfontEngineDeps = {
  host: SynthHostLike;
  moduleUrls: { fluidsynth: string; worklet: string };
  fontUrl: string;
  loadFont?: (url: string) => Promise<ArrayBuffer>;
  createContext?: () => AudioContext;
  /** Defaults to the audio context's own clock, which is what the audio is rendered against. */
  now?: () => number;
  /** Starts the pump and returns a function that stops it. */
  startPump?: (tick: () => void, intervalMs: number) => () => void;
};

/** How often the pump runs, and how far ahead it drains. */
const PUMP_INTERVAL_MS = 50;
const LOOKAHEAD_SECONDS = 0.2;
/**
 * How late a note may be and still play. Beyond this it is skipped, so a
 * main-thread stall cannot turn into a burst — see `pump-window.ts`.
 */
const GRACE_SECONDS = 0.2;
const POSITION_TICK_INTERVAL_MS = 1000 / 30;
const CC_VOLUME = 7;
const CC_PAN = 10;
const MAX_CC = 127;

type TrackState = {
  assignment: ChannelAssignment;
  volume: number;
  muted: boolean;
  solo: boolean;
};

type PendingOff = { atSeconds: number; assignment: ChannelAssignment; midi: number; noteId: string };

export class SoundfontPlaybackEngine implements PlaybackEngine {
  private readonly queue = new NoteQueue();
  private readonly governor: Governor;
  /** When the pump was last expected to run, for measuring how late it is. */
  private nextPumpDueAt: number | null = null;
  private readonly clock: PlaybackClock;
  private readonly deps: Required<Pick<SoundfontEngineDeps, 'loadFont' | 'startPump'>> & SoundfontEngineDeps;

  private context: AudioContext | null = null;
  private score: Score | null = null;
  private tempoMap = new TempoMap([], 480);
  private tracks = new Map<string, TrackState>();
  private observer: PlaybackObserver | null = null;
  private stopPump: (() => void) | null = null;
  private pendingOffs: PendingOff[] = [];
  private activeNoteIds = new Set<string>();
  private loopRange: ScoreRange | null = null;
  private lastReportedAt = 0;
  private initialized = false;
  /**
   * Where playback should begin once the pump actually runs.
   *
   * The clock is *not* started by `play()`. Starting it there loses the opening
   * of the piece: the first pump tick can be seconds late while the main thread
   * finishes worklet and soundfont setup, and by then the clock says the music
   * is already seconds in — so every note before that point is past its grace
   * window and gets skipped. Measured at 2.3s of lost opening on a real load.
   * Anchoring on the first tick instead means the piece starts where it should,
   * however busy the thread was.
   */
  private startAtSeconds: number | null = null;
  private metronomeEnabled = false;
  /** Click positions in ticks, with a cursor, mirroring how notes are drained. */
  private clicks: Array<{ tick: number; accent: boolean }> = [];
  private clickCursor = 0;
  /** Audition voices are held on their own channel so they never disturb a track. */
  private auditionHeld = new Map<number, ChannelAssignment>();

  constructor(deps: SoundfontEngineDeps) {
    this.deps = {
      ...deps,
      loadFont: deps.loadFont ?? (async (url) => loadSoundfont(url, { cache: await openSoundfontCache() })),
      startPump:
        deps.startPump ??
        ((tick, ms) => {
          const id = setInterval(tick, ms);
          return () => clearInterval(id);
        }),
    };
    this.clock = new PlaybackClock(() => this.now());
    // The governor's only knob is interpolation order; see governor.ts for why
    // polyphony is not a second rung.
    this.governor = new Governor({ onChange: (order) => this.deps.host.setInterpolation(order) });
  }

  private now(): number {
    if (this.deps.now) return this.deps.now();
    return this.context?.currentTime ?? 0;
  }

  private secondsForTick(tick: number): number {
    return this.tempoMap.ticksToSeconds(tick);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.context = this.deps.createContext?.() ?? new AudioContext();
    const soundfont = await this.deps.loadFont(this.deps.fontUrl);
    await this.deps.host.init(this.context, {
      fluidsynthModuleUrl: this.deps.moduleUrls.fluidsynth,
      workletModuleUrl: this.deps.moduleUrls.worklet,
      soundfont,
      instanceCount: 1,
    });
    this.initialized = true;
  }

  async loadScore(score: Score): Promise<void> {
    await this.initialize();
    this.score = score;
    this.tempoMap = new TempoMap(score.tempoMap, score.ppq);
    this.queue.load(flattenScoreForPlayback(score));
    this.clicks = metronomeClicks(score);
    this.clickCursor = 0;

    const { assignments } = allocateChannels(
      score.tracks.map((t) => ({ id: t.id, isPercussion: t.clef === 'percussion' })),
    );

    this.tracks = new Map();
    for (const track of score.tracks) {
      const assignment = assignments.get(track.id);
      if (!assignment) continue;
      this.tracks.set(track.id, { assignment, volume: track.volume, muted: track.muted, solo: track.solo });

      if (assignment.needsDrumTypeSwitch || track.clef === 'percussion') {
        this.deps.host.setChannelPercussion(assignment.instance, assignment.channel);
      } else {
        // A soundfont needs only the GM program number. The program-versus-name
        // rule the old engine used existed to choose among hand-built synth
        // voices and has no meaning here.
        this.deps.host.programSelect(assignment.instance, assignment.channel, track.midiProgram);
      }
      this.deps.host.controlChange(assignment.instance, assignment.channel, CC_PAN, panToCc(track.pan));
    }
    this.deps.host.setTrackCount(score.tracks.length);
    this.applyTrackLevels();
  }

  /** Volume, mute and solo all resolve to one CC7 value per channel. */
  private applyTrackLevels(): void {
    const anySolo = [...this.tracks.values()].some((t) => t.solo);
    for (const state of this.tracks.values()) {
      const audible = anySolo ? state.solo : !state.muted;
      const value = audible ? Math.round(state.volume * MAX_CC) : 0;
      this.deps.host.controlChange(state.assignment.instance, state.assignment.channel, CC_VOLUME, value);
    }
  }

  async play(fromTick?: number): Promise<void> {
    if (!this.score) return;
    await this.initialize();
    if (fromTick !== undefined) this.seek(fromTick);
    this.startAtSeconds = this.clock.positionSeconds;
    this.nextPumpDueAt = null;
    this.startPump();
    this.observer?.onStateChange('playing');
  }

  pause(): void {
    this.startAtSeconds = null;
    this.clock.pause();
    this.endPump();
    this.deps.host.allSoundOff();
    this.clearSounding();
    this.observer?.onStateChange('paused');
  }

  stop(): void {
    this.startAtSeconds = null;
    this.clock.stop();
    this.endPump();
    this.deps.host.allSoundOff();
    this.clearSounding();
    this.queue.seekToTick(0);
    this.clickCursor = 0;
    this.observer?.onPositionTick(0);
    this.observer?.onStateChange('stopped');
  }

  seek(tick: number): void {
    const seconds = this.secondsForTick(tick);
    this.clock.seek(seconds);
    this.queue.seekToTick(tick);
    this.clickCursor = this.clicks.findIndex((c) => c.tick >= tick);
    if (this.clickCursor < 0) this.clickCursor = this.clicks.length;
    this.deps.host.allSoundOff();
    this.clearSounding();

    // Report where we landed. Nothing else writes the store's position —
    // `PlaybackController.seek` only forwards here — so a seek made while
    // stopped (which is what clicking the sheet is) left the caret at
    // whatever tick it was already showing.
    //
    // Clearing the throttle baseline first is not tidiness: `report` gates on
    // the distance from the last reported position, so after a backward seek
    // that distance is negative and every report is suppressed until playback
    // climbs back past the old position. Jumping from bar 60 to bar 1 froze
    // the caret for the whole of those 59 bars.
    this.lastReportedAt = Number.NEGATIVE_INFINITY;
    this.report(seconds);
  }

  setTempoMultiplier(multiplier: number): void {
    this.clock.setRate(multiplier);
  }

  setLoop(range: ScoreRange | null): void {
    this.loopRange = range;
  }

  setTrackMute(trackId: string, muted: boolean): void {
    const state = this.tracks.get(trackId);
    if (!state) return;
    state.muted = muted;
    this.applyTrackLevels();
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    const state = this.tracks.get(trackId);
    if (!state) return;
    state.solo = solo;
    this.applyTrackLevels();
  }

  setMetronome(enabled: boolean): void {
    this.metronomeEnabled = enabled;
  }

  setMasterVolume(volume: number): void {
    this.deps.host.setMasterVolume(volume);
  }

  noteOn(midi: number, program: number, isPercussion = false): void {
    // Auditioning must not disturb the transport, so it borrows a channel
    // rather than routing through a track's.
    const assignment: ChannelAssignment = isPercussion
      ? { instance: 0, channel: 9, needsDrumTypeSwitch: false }
      : { instance: 0, channel: 15, needsDrumTypeSwitch: false };
    if (!isPercussion) this.deps.host.programSelect(assignment.instance, assignment.channel, program);
    this.deps.host.noteOn(assignment.instance, assignment.channel, midi, 100);
    this.auditionHeld.set(midi, assignment);
  }

  noteOff(midi: number): void {
    const assignment = this.auditionHeld.get(midi);
    if (!assignment) return;
    this.auditionHeld.delete(midi);
    this.deps.host.noteOff(assignment.instance, assignment.channel, midi);
  }

  setObserver(observer: PlaybackObserver | null): void {
    this.observer = observer;
  }

  dispose(): void {
    this.endPump();
    this.deps.host.dispose();
    this.context?.close?.();
    this.context = null;
    this.score = null;
    this.observer = null;
    this.initialized = false;
    this.clearSounding();
  }

  // ---- the pump ------------------------------------------------------------

  private startPump(): void {
    if (this.stopPump) return;
    this.stopPump = this.deps.startPump(() => this.tick(), PUMP_INTERVAL_MS);
  }

  private endPump(): void {
    this.stopPump?.();
    this.stopPump = null;
  }

  private tick(): void {
    this.measureLateness();
    if (this.startAtSeconds !== null) {
      this.clock.start(this.startAtSeconds);
      this.startAtSeconds = null;
    }
    const position = this.clock.positionSeconds;
    this.applyLoop(position);
    this.releaseDue(position);

    const untilSeconds = position + LOOKAHEAD_SECONDS;
    const drained = this.queue.drainUntil(this.tickForSeconds(untilSeconds));
    const { due } = planDispatch({
      notes: drained,
      secondsForTick: (tick) => this.secondsForTick(tick),
      positionSeconds: position,
      graceSeconds: GRACE_SECONDS,
    });

    for (const { note } of due) {
      const state = this.tracks.get(note.trackId);
      if (!state) continue;
      const { instance, channel } = state.assignment;
      this.deps.host.noteOn(instance, channel, note.midi, note.velocity);
      this.activeNoteIds.add(note.noteId);
      this.pendingOffs.push({
        atSeconds: this.secondsForTick(note.tick + note.durTicks),
        assignment: state.assignment,
        midi: note.midi,
        noteId: note.noteId,
      });
    }

    this.pumpMetronome(position, untilSeconds);
    this.report(position);
    if (this.queue.exhausted && this.pendingOffs.length === 0 && this.clock.isRunning) this.stop();
  }

  /**
   * How late this frame ran against when it was due.
   *
   * Measured on the audio clock rather than wall time, because that is the
   * clock the audio is rendered against and the one that matters if the thread
   * is being starved.
   */
  private measureLateness(): void {
    const now = this.now();
    const expected = this.nextPumpDueAt;
    this.nextPumpDueAt = now + PUMP_INTERVAL_MS / 1000;
    if (expected === null) return; // first frame has nothing to be late against
    this.governor.record(Math.max(0, now - expected));
  }

  /**
   * Clicks due in this window, scheduled ahead at their exact moment.
   *
   * Unlike notes, these can be placed precisely: an oscillator started with
   * `start(at)` sounds at that sample however busy the main thread is, so the
   * click stays steady even when the pump runs late.
   */
  private pumpMetronome(position: number, untilSeconds: number): void {
    if (!this.metronomeEnabled || !this.context) return;
    while (this.clickCursor < this.clicks.length) {
      const click = this.clicks[this.clickCursor];
      const atSeconds = this.secondsForTick(click.tick);
      if (atSeconds > untilSeconds) break;
      this.clickCursor += 1;
      if (atSeconds < position) continue; // already gone by; do not stack it up
      scheduleClick(this.context, this.context.destination, atSeconds, click.accent);
    }
  }

  /** Inverse of `secondsForTick`, for turning the lookahead window back into ticks. */
  private tickForSeconds(seconds: number): number {
    return this.tempoMap.secondsToTicks(seconds);
  }

  private releaseDue(position: number): void {
    const still: PendingOff[] = [];
    for (const off of this.pendingOffs) {
      if (off.atSeconds <= position) {
        this.deps.host.noteOff(off.assignment.instance, off.assignment.channel, off.midi);
        this.activeNoteIds.delete(off.noteId);
      } else {
        still.push(off);
      }
    }
    this.pendingOffs = still;
  }

  private applyLoop(position: number): void {
    if (!this.loopRange) return;
    if (position < this.secondsForTick(this.loopRange.endTick)) return;
    this.seek(this.loopRange.startTick);
    this.clock.start(this.secondsForTick(this.loopRange.startTick));
  }

  /**
   * Position and active notes, both at 30Hz.
   *
   * The engine this replaces called `onActiveNotes` on every note-on *and*
   * note-off — some 11,500 store updates for a three-minute piece, on the same
   * thread the scheduler runs on. Coalescing is what keeps that work off the
   * pump's back.
   */
  private report(position: number): void {
    const nowMs = position * 1000;
    if (nowMs - this.lastReportedAt < POSITION_TICK_INTERVAL_MS) return;
    this.lastReportedAt = nowMs;
    this.observer?.onPositionTick(Math.max(0, Math.round(this.tickForSeconds(position))));
    this.observer?.onActiveNotes([...this.activeNoteIds]);
  }

  private clearSounding(): void {
    this.pendingOffs = [];
    if (this.activeNoteIds.size === 0) return;
    this.activeNoteIds.clear();
    this.observer?.onActiveNotes([]);
  }
}

function panToCc(pan: number): number {
  return Math.round(((Math.min(1, Math.max(-1, pan)) + 1) / 2) * MAX_CC);
}
