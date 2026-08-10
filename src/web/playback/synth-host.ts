/**
 * The one module that talks to `js-synthesizer`.
 *
 * Hosts N libfluidsynth instances inside an `AudioWorklet`, so synthesis runs
 * on the audio thread where React and the garbage collector cannot starve it.
 * Everything above this only knows about instances, channels and notes.
 *
 * **The worklet module URLs are injected, not resolved here.** `music_io` is a
 * library and cannot assume how a consuming app serves assets; the app decides
 * (a `?url` import, a copy into its public directory) and passes them in.
 *
 * The synth factory is injected too, which lets the rules that matter be
 * tested against a stub instead of being verifiable only by ear. The
 * percussion guard below is the one that most needs it.
 */
import { headroomTrimFor, LIMITER_CEILING_DB } from './mix.js';
import { createWorkletQuietModuleUrl } from './quiet-stub-notices.js';

/** The slice of `AudioWorkletNodeSynthesizer` this host uses. */
export type SynthInstance = {
  init(sampleRate: number): void;
  createAudioNode(context: BaseAudioContext, bufferSize: number): AudioNode;
  loadSFont(data: ArrayBuffer): Promise<number>;
  midiNoteOn(channel: number, midi: number, velocity: number): void;
  midiNoteOff(channel: number, midi: number): void;
  midiProgramSelect(channel: number, sfontId: number, bank: number, preset: number): void;
  midiControl(channel: number, control: number, value: number): void;
  midiSetChannelType(channel: number, isDrum: boolean): void;
  midiAllSoundsOff(channel?: number): void;
  setInterpolation(order: number): void;
  close(): void;
};

export type SynthHostOptions = {
  fluidsynthModuleUrl: string;
  workletModuleUrl: string;
  soundfont: ArrayBuffer;
  instanceCount: number;
};

/** Big enough that the worklet is not woken constantly, small enough not to add audible latency. */
const RENDER_BUFFER_SIZE = 8192;

/**
 * Where General MIDI keeps its drum kits. Channel 9 is already there in GM
 * mode; any other channel has to be sent there explicitly.
 */
const DRUM_BANK = 128;
/** The kit channel 9 defaults to, so a switched channel matches it. */
const STANDARD_KIT = 0;

export class SynthHost {
  private synths: SynthInstance[] = [];
  private sfontIds: number[] = [];
  /** `instance:channel` for every channel that is percussion — see `programSelect`. */
  private percussionChannels = new Set<string>();
  private master: GainNode | null = null;
  private masterVolume = 1;
  private trackCount = 1;

  constructor(
    private readonly deps: {
      /** May be async: the real factory imports `js-synthesizer` on first use. */
      createSynth: () => SynthInstance | Promise<SynthInstance>;
    },
  ) {}

  async init(context: BaseAudioContext, options: SynthHostOptions): Promise<void> {
    // Before libfluidsynth, so its emscripten module adopts a printErr that
    // drops the build-stub notices. Best-effort: if blobs are unavailable the
    // notices stay and nothing else changes.
    const quietUrl = createWorkletQuietModuleUrl();
    if (quietUrl) {
      try {
        await context.audioWorklet.addModule(quietUrl);
      } finally {
        URL.revokeObjectURL(quietUrl);
      }
    }
    // Order matters: the worklet build expects libfluidsynth already present.
    await context.audioWorklet.addModule(options.fluidsynthModuleUrl);
    await context.audioWorklet.addModule(options.workletModuleUrl);

    // Master chain, same arithmetic as the engine it replaces: a headroom trim
    // sized by how many channels sum into it, then a limiter catching the
    // phase-aligned peaks the trim cannot predict. The spike measured 64 voices
    // peaking at 1.004, so the limiter is not optional.
    const master = context.createGain();
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = LIMITER_CEILING_DB;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    master.connect(limiter);
    limiter.connect(context.destination);
    this.master = master;

    for (let i = 0; i < options.instanceCount; i += 1) {
      const synth = await this.deps.createSynth();
      synth.init(context.sampleRate);
      synth.createAudioNode(context, RENDER_BUFFER_SIZE).connect(master);
      this.sfontIds[i] = await synth.loadSFont(options.soundfont);
      this.synths[i] = synth;
    }
    this.applyMasterGain();
  }

  /**
   * Marks a channel as percussion.
   *
   * Channel 9 already is one in fluidsynth's GM mode and needs no call; any
   * other channel does, which is what lets a second drum track share an
   * instance rather than costing a whole synth for its own channel 9.
   */
  setChannelPercussion(instance: number, channel: number): void {
    this.percussionChannels.add(`${instance}:${channel}`);
    if (channel === 9) return;
    const synth = this.synths[instance];
    if (!synth) return;
    synth.midiSetChannelType(channel, true);
    // Switching the type is not enough on its own. It tells fluidsynth to read
    // later program changes from the drum bank, but leaves the channel on the
    // preset it already had — bank 0, program 0, a piano. A second drum track
    // therefore played its congas and cowbells as piano notes at those pitches,
    // which is exactly what it sounded like.
    //
    // Measured against a real synth: the same conga on channel 9 peaked 0.1229
    // at 0.01187 RMS, this channel with only the type switch gave 0.1115 at
    // 0.01437 — a different instrument — and with the select below it matched
    // channel 9 to the digit.
    synth.midiProgramSelect(channel, this.sfontIds[instance], DRUM_BANK, STANDARD_KIT);
  }

  /**
   * Selects a GM program — **never on a percussion channel**.
   *
   * The spike measured this directly: selecting a program on channel 9
   * replaces fluidsynth's working default with a preset that is not at that
   * address, and the channel goes silent. Every explicit selection route gave
   * peak 0.0000; leaving it alone gave 0.3120. This guard is why drums sound.
   */
  programSelect(instance: number, channel: number, program: number): void {
    if (this.percussionChannels.has(`${instance}:${channel}`)) return;
    this.synths[instance]?.midiProgramSelect(channel, this.sfontIds[instance], 0, program);
  }

  noteOn(instance: number, channel: number, midi: number, velocity: number): void {
    this.synths[instance]?.midiNoteOn(channel, midi, velocity);
  }

  noteOff(instance: number, channel: number, midi: number): void {
    this.synths[instance]?.midiNoteOff(channel, midi);
  }

  controlChange(instance: number, channel: number, control: number, value: number): void {
    this.synths[instance]?.midiControl(channel, control, value);
  }

  /** Silences everything immediately — stop, seek, and panic all go through here. */
  allSoundOff(): void {
    for (const synth of this.synths) synth.midiAllSoundsOff();
  }

  /** The governor's one confirmed knob; applies to every instance at once. */
  setInterpolation(order: number): void {
    for (const synth of this.synths) synth.setInterpolation(order);
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = volume;
    this.applyMasterGain();
  }

  /** How many channels are summing, which sizes the headroom trim. */
  setTrackCount(count: number): void {
    this.trackCount = count;
    this.applyMasterGain();
  }

  private applyMasterGain(): void {
    if (this.master) this.master.gain.value = this.masterVolume * headroomTrimFor(this.trackCount);
  }

  dispose(): void {
    for (const synth of this.synths) synth.close();
    this.synths = [];
    this.sfontIds = [];
    this.percussionChannels.clear();
    this.master = null;
  }
}
