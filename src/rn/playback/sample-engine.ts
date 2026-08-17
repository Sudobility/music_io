/**
 * React Native playback: FluidR3, played from samples.
 *
 * The web engine runs libfluidsynth (WebAssembly) inside an `AudioWorklet`.
 * React Native has neither — `react-native-audio-api` exposes no `addModule`
 * and Hermes has no WebAssembly — so that engine cannot be ported, only
 * replaced. See `spikes/rn-sample-playback.md`.
 *
 * What it is replaced with is **the same soundfont**, pre-rendered. Benjamin
 * Gleitzman's packs are per-note recordings taken from `FluidR3_GM.sf2`, the
 * font the web engine plays as `FluidR3Mono_GM.sf3`. Every one of the 128 GM
 * programs is covered, at every key from A0 to C8, so a note here is the same
 * recording the browser plays rather than an approximation of it. That
 * distinction is the whole reason this engine exists: the RN engine that was
 * deleted synthesised its own instruments from oscillators and could never
 * match the web, and a wrong sound is worse than a clear error.
 *
 * What is *not* reproduced is SF2's per-zone filtering, LFOs and modulator
 * envelopes — fluidsynth applies those live and a pre-rendered sample cannot.
 * In practice that costs some expressive variation, not the instrument's
 * identity.
 *
 * The transport half — flattening a score, the note cursor, the dispatch
 * window, the master trim — is `shared/playback/`, the same code the web
 * engine runs. This file is only the part that turns a due note into sound.
 *
 * It deliberately does *not* reuse `SoundfontPlaybackEngine`'s pump by
 * refactoring it behind a synth port. That engine is verified on real devices
 * and this one cannot be until it runs on a phone; destabilising the working
 * one to serve the unproven one is the wrong order. Once this is device-tested,
 * merging the two transports is the obvious follow-up.
 */
import type {
  PlaybackEngine,
  PlaybackLoadState,
  PlaybackObserver,
  Score,
  ScoreRange,
  TransportPlaybackState,
} from '@sudobility/music_types';
import { TempoMap, gmInstrument, gmKitAt, isPercussionTrack } from '@sudobility/music_lib';
import { NoteQueue } from '../../shared/playback/note-queue.js';
import { flattenScoreForPlayback, metronomeClicks } from '../../shared/playback/schedule.js';
import type { MetronomeClick, ScheduledNote } from '../../shared/playback/schedule.js';
import { planDispatch } from '../../shared/playback/pump-window.js';
import { headroomTrimFor } from '../../shared/playback/mix.js';
import { gmPackName, percussionPackName } from './gm-pack-name.js';
import { PackLibrary } from './pack-library.js';
import { RELEASE_SECONDS, planVoice } from './voice-plan.js';
import type { VoicePlan } from './voice-plan.js';
import { sustains } from './expression.js';
import { loadAudioApi } from './audio-api.js';
export { base64ToBytes } from './pack-library.js';
import type { AudioApi, RNAudioBuffer, RNAudioContext, RNGainNode } from './audio-api.js';
import { applySustainLoop } from './sustain-loop.js';

/** How often the pump looks for notes to schedule. */
const PUMP_INTERVAL_MS = 50;
/** How far ahead of the clock notes are handed to the audio graph. */
const LOOKAHEAD_SECONDS = 0.2;
/** How late a note may be and still be played rather than skipped. */
const GRACE_SECONDS = 0.2;
const POSITION_TICK_INTERVAL_MS = 1000 / 30;
/** Metronome click pitches, accented downbeat first. */
const CLICK_HZ = { accent: 1600, normal: 1200 };
const CLICK_SECONDS = 0.03;

export type SampleEngineDeps = {
  /** Overridable so tests can drive the engine with a fake audio graph. */
  loadAudioApi?: () => Promise<AudioApi>;
  /** Fetches a pack body. Overridable for tests and for self-hosting. */
  fetchPack?: (url: string) => Promise<string>;
  /** Base URL for the melodic packs. An app may host its own copy; they are CC-BY 3.0. */
  packBase?: string;
  /**
   * Base URL for the drum-kit packs.
   *
   * No default, because there is nowhere to default *to*: no CDN publishes
   * pre-rendered GM percussion under a usable licence, so these are rendered
   * by `scripts/build-percussion-packs.mjs` and hosted by the app alongside
   * its other audio assets. An app with percussion in its scores must set this.
   */
  percussionBase?: string;
  /** Overridable so tests can step the pump by hand instead of waiting. */
  startPump?: (tick: () => void, intervalMs: number) => () => void;
};

type Voice = { source: { stop(when?: number): void; disconnect(): unknown }; gain: RNGainNode; noteId?: string; endsAt: number };

function defaultFetchPack(url: string): Promise<string> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Sample pack ${url} responded ${r.status}`);
    return r.text();
  });
}

function defaultStartPump(tick: () => void, intervalMs: number): () => void {
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}

export class RNSamplePlaybackEngine implements PlaybackEngine {
  private readonly deps: Required<Omit<SampleEngineDeps, 'packBase' | 'percussionBase'>> & {
    packBase?: string;
    percussionBase?: string;
  };

  private api: AudioApi | null = null;
  private ctx: RNAudioContext | null = null;
  private master: RNGainNode | null = null;

  private score: Score | null = null;
  private tempoMap: TempoMap | null = null;
  private readonly queue = new NoteQueue();
  private clicks: MetronomeClick[] = [];
  private clickCursor = 0;

  private library: PackLibrary | null = null;

  private observer: PlaybackObserver | null = null;
  private state: TransportPlaybackState = 'stopped';
  private loadState: PlaybackLoadState = { status: 'idle' };

  private stopPump: (() => void) | null = null;
  private stopPositionTimer: (() => void) | null = null;
  /** Context time corresponding to `originTick`. */
  private originContextTime = 0;
  private originTick = 0;
  private positionTick = 0;
  private tempoMultiplier = 1;
  private loop: ScoreRange | null = null;
  private masterVolume = 1;
  private metronomeOn = false;
  private headroom = 1;

  private readonly muted = new Set<string>();
  private readonly soloed = new Set<string>();
  private readonly voices: Voice[] = [];
  private readonly auditioned = new Map<number, Voice>();
  private activeNoteIds: string[] = [];
  private activeNotesDirty = false;

  constructor(deps: SampleEngineDeps = {}) {
    this.deps = {
      loadAudioApi: deps.loadAudioApi ?? loadAudioApi,
      fetchPack: deps.fetchPack ?? defaultFetchPack,
      startPump: deps.startPump ?? defaultStartPump,
      packBase: deps.packBase,
      percussionBase: deps.percussionBase,
    };
  }

  // ---- lifecycle ---------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.ctx) return;
    const api = await this.deps.loadAudioApi();
    const ctx = new api.AudioContext();
    const master = ctx.createGain();
    master.gain.value = this.masterVolume;
    master.connect(ctx.destination);
    this.api = api;
    this.ctx = ctx;
    this.master = master;
    this.library = new PackLibrary({
      fetchPack: this.deps.fetchPack,
      decodeAudioData: (bytes) => api.decodeAudioData(bytes),
      packBase: this.deps.packBase,
      percussionBase: this.deps.percussionBase,
    });
  }

  async loadScore(score: Score): Promise<void> {
    this.stopAllVoices();
    this.score = score;
    this.tempoMap = new TempoMap(score.tempoMap, score.ppq);
    this.queue.load(flattenScoreForPlayback(score));
    this.clicks = metronomeClicks(score);
    this.clickCursor = 0;
    this.headroom = headroomTrimFor(score.tracks.length);
    this.seek(0);
  }

  // ---- sample packs ------------------------------------------------------

  /** The pack name for a track, honouring the percussion/kit distinction. */
  private packNameForTrack(trackId: string): string | null {
    const track = this.score?.tracks.find((t) => t.id === trackId);
    if (!track) return null;
    // A percussion track's `midiProgram` is a kit, not an instrument — the two
    // never agree, because Brush is 40 and program 40 is Violin. `gmKitAt`
    // resolves any address to the kit whose region contains it, so a score that
    // arrives at a program GM defines no kit at still plays.
    if (isPercussionTrack(track)) return percussionPackName(gmKitAt(track.midiProgram).program);
    const instrument = gmInstrument(track.midiProgram);
    return instrument ? gmPackName(track.midiProgram, instrument.name) : null;
  }

  /** Loads every pack the score needs, reporting progress across all of them. */
  private async ensureScorePacks(): Promise<void> {
    const names = new Set<string>();
    for (const track of this.score?.tracks ?? []) {
      const name = this.packNameForTrack(track.id);
      if (name && !this.library!.has(name)) names.add(name);
    }
    if (names.size === 0) {
      this.reportLoad({ status: 'ready' });
      return;
    }

    this.reportLoad({ status: 'loading', fraction: 0 });
    let done = 0;
    try {
      for (const name of names) {
        await this.library!.ensure(name);
        done += 1;
        this.reportLoad({ status: 'loading', fraction: done / names.size });
      }
      this.reportLoad({ status: 'ready' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportLoad({ status: 'failed', message });
      throw error;
    }
  }

  private reportLoad(state: PlaybackLoadState): void {
    this.loadState = state;
    this.observer?.onLoadStateChange?.(state);
  }

  // ---- transport ---------------------------------------------------------

  /**
   * Reports `playing` only once a note can actually sound.
   *
   * The same rule the web engine follows, and for the same reason: the caret
   * dead-reckons from elapsed real time between position reports, so announcing
   * `playing` before the packs are decoded would glide it silently through
   * several bars and snap it back when the music finally started.
   */
  async play(fromTick?: number): Promise<void> {
    await this.initialize();
    if (fromTick !== undefined) this.seek(fromTick);
    await this.ensureScorePacks();
    await this.ctx!.resume();

    this.originContextTime = this.ctx!.currentTime;
    this.originTick = this.positionTick;
    this.setState('playing');
    this.stopPump = this.deps.startPump(() => this.pump(), PUMP_INTERVAL_MS);
    this.stopPositionTimer = this.deps.startPump(() => this.reportPosition(), POSITION_TICK_INTERVAL_MS);
    this.pump();
    this.reportPosition();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    const tick = this.currentTick();
    this.haltPump();
    this.stopAllVoices();
    this.seek(tick);
    this.setState('paused');
  }

  stop(): void {
    this.haltPump();
    this.stopAllVoices();
    this.seek(0);
    this.setState('stopped');
  }

  seek(tick: number): void {
    this.positionTick = Math.max(0, tick);
    this.queue.seekToTick(this.positionTick);
    this.clickCursor = this.clicks.findIndex((c) => c.tick >= this.positionTick);
    if (this.clickCursor < 0) this.clickCursor = this.clicks.length;
    this.originTick = this.positionTick;
    this.originContextTime = this.ctx?.currentTime ?? 0;
    this.activeNotesDirty = false;
    this.setActiveNotes([]);
    this.observer?.onPositionTick(this.positionTick);
  }

  private haltPump(): void {
    this.stopPump?.();
    this.stopPump = null;
    this.stopPositionTimer?.();
    this.stopPositionTimer = null;
  }

  private setState(next: TransportPlaybackState): void {
    if (this.state === next) return;
    this.state = next;
    this.observer?.onStateChange(next);
  }

  /** Score tick at the context's current time, from the tempo map and speed. */
  private currentTick(): number {
    if (!this.ctx || !this.tempoMap) return this.positionTick;
    const elapsed = (this.ctx.currentTime - this.originContextTime) * this.tempoMultiplier;
    const originSeconds = this.tempoMap.ticksToSeconds(this.originTick);
    return this.tempoMap.secondsToTicks(originSeconds + elapsed);
  }

  private secondsForTick(tick: number): number {
    if (!this.tempoMap || !this.ctx) return 0;
    const fromOrigin =
      (this.tempoMap.ticksToSeconds(tick) - this.tempoMap.ticksToSeconds(this.originTick)) /
      this.tempoMultiplier;
    return this.originContextTime + fromOrigin;
  }

  private reportPosition(): void {
    this.positionTick = this.currentTick();
    this.observer?.onPositionTick(this.positionTick);
  }

  // ---- the pump ----------------------------------------------------------

  private pump(): void {
    if (!this.ctx || this.state !== 'playing') return;
    const now = this.ctx.currentTime;
    this.reapVoices(now);

    const horizonTick = this.tickAtContextTime(now + LOOKAHEAD_SECONDS);

    if (this.loop && horizonTick >= this.loop.endTick) {
      this.drainThrough(this.loop.endTick, now);
      this.seek(this.loop.startTick);
      this.originContextTime = this.secondsForTick(this.loop.endTick);
      this.originTick = this.loop.startTick;
      return;
    }

    this.drainThrough(horizonTick, now);
    this.flushActiveNotes();

    if (this.queue.exhausted && this.voices.length === 0 && !this.loop) {
      this.stop();
    }
  }

  private drainThrough(horizonTick: number, now: number): void {
    const drained = this.queue.drainUntil(horizonTick);
    const { due } = planDispatch({
      notes: drained,
      secondsForTick: (tick) => this.secondsForTick(tick),
      positionSeconds: now,
      graceSeconds: GRACE_SECONDS,
    });
    for (const { note, atSeconds } of due) {
      if (this.audibleTrack(note.trackId)) this.startNote(note, atSeconds);
    }
    if (this.metronomeOn) this.scheduleClicks(horizonTick);
  }

  private tickAtContextTime(contextTime: number): number {
    if (!this.tempoMap) return this.positionTick;
    const elapsed = (contextTime - this.originContextTime) * this.tempoMultiplier;
    return this.tempoMap.secondsToTicks(this.tempoMap.ticksToSeconds(this.originTick) + elapsed);
  }

  /** Mute/solo, with solo winning: any solo means everything unsoloed is silent. */
  private audibleTrack(trackId: string): boolean {
    if (this.soloed.size > 0) return this.soloed.has(trackId);
    return !this.muted.has(trackId);
  }

  private startNote(note: ScheduledNote, atSeconds: number): void {
    const packName = this.packNameForTrack(note.trackId);
    if (!packName) return;
    const track = this.score?.tracks.find((t) => t.id === note.trackId);
    const voicing = this.library?.voice(packName, note.midi, Boolean(track && isPercussionTrack(track)));
    if (!voicing) return;
    const { choice, buffer } = voicing;

    const durationSeconds =
      this.secondsForTick(note.tick + note.durTicks) - this.secondsForTick(note.tick);
    const program = track?.midiProgram;
    const plan = planVoice({
      atSeconds,
      durationSeconds,
      velocity: note.velocity,
      trackGain: this.headroom,
      choice,
      // Percussion has no melodic expression: a kit's programs address kits,
      // and a drum is a one-shot whose decay is already in the recording.
      program: track && isPercussionTrack(track) ? undefined : program,
    });

    const voice = this.buildVoiceFromPlan(buffer, plan, program !== undefined && sustains(program));
    voice.noteId = note.noteId;
    this.voices.push(voice);
    this.markActiveNotesDirty();
  }

  /**
   * One voice: source -> [low-pass] -> gain -> master.
   *
   * The filter is only built when this velocity actually calls for one (71 of
   * the 128 instruments never do), because a node per voice is real cost in a
   * dense passage.
   */
  private buildVoiceFromPlan(buffer: RNAudioBuffer, plan: VoicePlan, mayLoop: boolean): Voice {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // `detune` rather than `playbackRate`: it is already in cents, so no
    // exponential conversion here to get subtly wrong. Packs cover every key,
    // so this is normally 0 and only matters for a pack with gaps.
    if (plan.detuneCents !== 0) source.detune.value = plan.detuneCents;
    if (mayLoop) applySustainLoop(source, buffer, plan.releaseAt - plan.startAt, plan.sampleMidi);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(plan.gain, plan.startAt);
    // Hold flat, then release. Linear rather than exponential: exponential
    // ramps cannot reach zero, and the residual is what clicks.
    amp.gain.setValueAtTime(plan.gain, plan.releaseAt);
    amp.gain.linearRampToValueAtTime(0, plan.endAt);

    if (plan.cutoffHz === null) {
      source.connect(amp);
    } else {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = plan.cutoffHz;
      source.connect(filter);
      filter.connect(amp);
    }
    amp.connect(this.master!);
    source.start(plan.startAt);
    source.stop(plan.endAt);

    return { source, gain: amp, endsAt: plan.endAt };
  }

  /** The flat-envelope form, for the metronome and for auditioning a key. */
  private buildVoice(
    buffer: RNAudioBuffer,
    detuneCents: number,
    gain: number,
    startAt: number,
    releaseAt: number,
  ): Voice {
    return this.buildVoiceFromPlan(
      buffer,
      {
        startAt,
        releaseAt,
        endAt: releaseAt + RELEASE_SECONDS,
        gain,
        cutoffHz: null,
        uri: '',
        detuneCents,
        sampleMidi: 0,
      },
      false,
    );
  }

  private reapVoices(now: number): void {
    let changed = false;
    for (let i = this.voices.length - 1; i >= 0; i -= 1) {
      if (this.voices[i]!.endsAt <= now) {
        this.voices[i]!.gain.disconnect();
        this.voices.splice(i, 1);
        changed = true;
      }
    }
    if (changed) this.markActiveNotesDirty();
  }

  private setActiveNotes(ids: string[]): void {
    const same = ids.length === this.activeNoteIds.length && ids.every((id, i) => id === this.activeNoteIds[i]);
    if (same) return;
    this.activeNoteIds = ids;
    this.observer?.onActiveNotes(ids);
  }

  private markActiveNotesDirty(): void {
    this.activeNotesDirty = true;
  }

  private flushActiveNotes(): void {
    if (!this.activeNotesDirty) return;
    this.activeNotesDirty = false;
    const ids = this.voices.map((v) => v.noteId).filter((id): id is string => id !== undefined);
    this.setActiveNotes(ids);
  }

  private stopAllVoices(): void {
    for (const voice of this.voices) {
      try {
        voice.source.stop();
      } catch {
        // Already stopped; nothing to undo.
      }
      voice.gain.disconnect();
    }
    this.voices.length = 0;
    this.activeNotesDirty = false;
    this.setActiveNotes([]);
  }

  // ---- metronome ---------------------------------------------------------

  private scheduleClicks(horizonTick: number): void {
    while (this.clickCursor < this.clicks.length && this.clicks[this.clickCursor]!.tick <= horizonTick) {
      const click = this.clicks[this.clickCursor]!;
      this.clickCursor += 1;
      const at = this.secondsForTick(click.tick);
      if (at < this.ctx!.currentTime) continue;
      this.scheduleClick(at, click.accent);
    }
  }

  /**
   * A short sine blip. Synthesised rather than sampled because the packs are
   * instruments and carry no click, and a metronome is one of the few sounds
   * where a plain tone is what is wanted anyway.
   */
  private scheduleClick(at: number, accent: boolean): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = accent ? CLICK_HZ.accent : CLICK_HZ.normal;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(accent ? 0.5 : 0.3, at);
    amp.gain.linearRampToValueAtTime(0, at + CLICK_SECONDS);
    osc.connect(amp);
    amp.connect(this.master!);
    osc.start(at);
    osc.stop(at + CLICK_SECONDS);
  }

  // ---- settings ----------------------------------------------------------

  setTempoMultiplier(multiplier: number): void {
    // Re-anchor first, or the elapsed time already played would be reinterpreted
    // at the new speed and the position would jump.
    if (this.ctx) {
      this.originTick = this.currentTick();
      this.originContextTime = this.ctx.currentTime;
    }
    this.tempoMultiplier = multiplier;
  }

  setLoop(range: ScoreRange | null): void {
    this.loop = range;
  }

  setTrackMute(trackId: string, muted: boolean): void {
    if (muted) this.muted.add(trackId);
    else this.muted.delete(trackId);
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    if (solo) this.soloed.add(trackId);
    else this.soloed.delete(trackId);
  }

  /**
   * Re-reads the mix off `score`, scheduling nothing.
   *
   * Mute and solo only: this engine has never carried per-track volume or pan
   * — `muted` and `soloed` are the whole of its mix state — so there is nothing
   * to push for the other two. That is a gap in this engine rather than
   * something `applyMix` introduces, and it predates the method. Fixing it
   * means giving each track its own gain node, which belongs with the device
   * testing this engine is still waiting on.
   */
  applyMix(score: Score): void {
    this.muted.clear();
    this.soloed.clear();
    for (const track of score.tracks) {
      if (track.muted) this.muted.add(track.id);
      if (track.solo) this.soloed.add(track.id);
    }
  }

  setMetronome(enabled: boolean): void {
    this.metronomeOn = enabled;
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = Math.min(1, Math.max(0, volume));
    if (this.master) this.master.gain.value = this.masterVolume;
  }

  // ---- audition ----------------------------------------------------------

  /**
   * Sounds a pitch now and holds it, touching no transport state — no seek, no
   * state change, no active-note report. Fire-and-forget: the caller is a
   * keypress handler and cannot await a pack download.
   */
  noteOn(midi: number, program: number, isPercussion = false): void {
    void this.auditionNote(midi, program, isPercussion);
  }

  private async auditionNote(midi: number, program: number, isPercussion: boolean): Promise<void> {
    await this.initialize();
    let name: string;
    if (isPercussion) {
      // `program` is a kit address here, not an instrument. Auditioning it
      // through the GM instrument table played a violin for a snare.
      name = percussionPackName(gmKitAt(program).program);
    } else {
      const instrument = gmInstrument(program);
      if (!instrument) return;
      name = gmPackName(program, instrument.name);
    }
    await this.library!.ensure(name);

    const voicing = this.library!.voice(name, midi, isPercussion);
    if (!voicing) return;
    const { choice, buffer } = voicing;

    this.auditioned.get(midi)?.source.stop();
    const now = this.ctx!.currentTime;
    // Held until noteOff: released far enough out that an ordinary key press
    // ends it first, and bounded so a lost noteOff cannot ring forever.
    const voice = this.buildVoice(buffer, choice.detuneCents, this.masterVolume, now, now + 30);
    this.auditioned.set(midi, voice);
  }

  noteOff(midi: number): void {
    const voice = this.auditioned.get(midi);
    if (!voice) return;
    this.auditioned.delete(midi);
    const now = this.ctx?.currentTime ?? 0;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + RELEASE_SECONDS);
    try {
      voice.source.stop(now + RELEASE_SECONDS);
    } catch {
      // Already stopped.
    }
  }

  // ---- observer / teardown -----------------------------------------------

  setObserver(observer: PlaybackObserver | null): void {
    this.observer = observer;
    observer?.onLoadStateChange?.(this.loadState);
  }

  dispose(): void {
    this.haltPump();
    this.stopAllVoices();
    for (const voice of this.auditioned.values()) voice.gain.disconnect();
    this.auditioned.clear();
    this.master?.disconnect();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.api = null;
  }
}
