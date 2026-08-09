/**
 * The mixer: one channel per track, and the master bus they sum into.
 *
 * Master and channels live together rather than in two modules because they are
 * not independent — the master's headroom trim is sized by how many channels
 * exist (see `mix.ts`), so every rebuild has to re-apply it. Splitting them
 * would put that coupling across a module boundary where it is easy to forget.
 *
 * Nothing here knows about the transport. The engine owns *when* notes sound;
 * this owns *how loud* and *through what*.
 */
import * as Tone from 'tone';
import type { Score } from '@sudobility/music_types';
import { createInstrument, voiceSourceFor } from './instruments/index.js';
import type { InstrumentHandle } from './instruments/index.js';
import { headroomTrimFor, LIMITER_CEILING_DB } from './mix.js';

type TrackChannel = {
  instrument: InstrumentHandle;
  panner: Tone.Panner;
  gain: Tone.Gain;
  /** Runtime (possibly live-overridden — see `setMute`/`setSolo`) mute/solo/volume, seeded from `Track` on a genuine reload. */
  muted: boolean;
  solo: boolean;
  volume: number;
};

export class Mixer {
  private channels = new Map<string, TrackChannel>();
  private masterGain: Tone.Gain | null = null;
  private masterLimiter: Tone.Limiter | null = null;
  private masterVolume = 1;

  /** The node every channel sums into. Built on first use, so nothing is created before audio starts. */
  ensureMaster(): Tone.Gain {
    if (!this.masterGain) {
      this.masterLimiter = new Tone.Limiter(LIMITER_CEILING_DB).toDestination();
      this.masterGain = new Tone.Gain(this.masterVolume);
      this.masterGain.connect(this.masterLimiter);
      this.applyMasterGain();
    }
    return this.masterGain;
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = volume;
    this.applyMasterGain();
  }

  /** The user's master volume with the track-count headroom folded underneath it. */
  private applyMasterGain(): void {
    if (this.masterGain) this.masterGain.gain.value = this.masterVolume * headroomTrimFor(this.channels.size);
  }

  /**
   * Tears down and recreates every track's instrument/panner/gain nodes.
   *
   * Disposing is how the engine guarantees silence — it is the one operation
   * that stops a voice whatever kind it is (see the engine's "No stuck notes").
   * When `reseedFromScore` is true (a genuine `loadScore`), each channel's
   * mute/solo/volume is read fresh from `Track`; otherwise (silencing for
   * pause/stop/seek/tempo-change) the previous *runtime* values are preserved,
   * so a live-only `setMute`/`setSolo` override — not yet persisted to the
   * score, which is the UI's job — survives across it.
   */
  rebuild(score: Score | null, reseedFromScore: boolean): void {
    const previous = this.channels;
    for (const channel of previous.values()) {
      channel.instrument.dispose();
      channel.panner.dispose();
      channel.gain.dispose();
    }
    this.channels = new Map();
    if (!score) return;

    const master = this.ensureMaster();
    for (const track of score.tracks) {
      const runtime = !reseedFromScore ? previous.get(track.id) : undefined;
      const instrument = createInstrument(voiceSourceFor(track), track.clef === 'percussion');
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
    // After the channels exist, so the trim sees the new track count.
    this.applyMasterGain();
    this.applyChannelGains();
  }

  setMute(trackId: string, muted: boolean): void {
    const channel = this.channels.get(trackId);
    if (!channel) return;
    channel.muted = muted;
    this.applyChannelGains();
  }

  setSolo(trackId: string, solo: boolean): void {
    const channel = this.channels.get(trackId);
    if (!channel) return;
    channel.solo = solo;
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

  /**
   * The voice a track's notes sound on, or `undefined` for a track with no
   * channel — muted, soloed away, or simply not in the loaded score.
   */
  instrumentFor(trackId: string): InstrumentHandle | undefined {
    return this.channels.get(trackId)?.instrument;
  }

  /** Releases every channel. The master bus survives, so `disposeMaster` is separate. */
  disposeChannels(): void {
    for (const channel of this.channels.values()) {
      channel.instrument.dispose();
      channel.panner.dispose();
      channel.gain.dispose();
    }
    this.channels.clear();
  }

  disposeMaster(): void {
    this.masterGain?.dispose();
    this.masterGain = null;
    this.masterLimiter?.dispose();
    this.masterLimiter = null;
  }
}
