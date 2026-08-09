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

/** The slice of `AudioWorkletNodeSynthesizer` this host uses. */
export type SynthInstance = {
  init(sampleRate: number): void;
  createAudioNode(context: BaseAudioContext, bufferSize: number): AudioNode;
  loadSFont(data: ArrayBuffer): Promise<number>;
  midiNoteOn(channel: number, midi: number, velocity: number): void;
  midiNoteOff(channel: number, midi: number): void;
  midiProgramSelect(channel: number, sfontId: number, bank: number, preset: number): void;
  midiControl(channel: number, control: number, value: number): void;
  midiSetChannelType(channel: number, type: number): void;
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

/** fluidsynth's channel-type constant for a drum channel. */
const CHANNEL_TYPE_DRUM = 1;
/** Big enough that the worklet is not woken constantly, small enough not to add audible latency. */
const RENDER_BUFFER_SIZE = 8192;

export class SynthHost {
  private synths: SynthInstance[] = [];
  private sfontIds: number[] = [];
  /** `instance:channel` for every channel that is percussion — see `programSelect`. */
  private percussionChannels = new Set<string>();
  private master: GainNode | null = null;
  private masterVolume = 1;
  private trackCount = 1;

  constructor(private readonly deps: { createSynth: () => SynthInstance }) {}

  async init(context: AudioContext, options: SynthHostOptions): Promise<void> {
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
      const synth = this.deps.createSynth();
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
    this.synths[instance]?.midiSetChannelType(channel, CHANNEL_TYPE_DRUM);
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
