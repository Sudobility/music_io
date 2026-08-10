/**
 * Offline audio rendering through the shared soundfont synth.
 *
 * Export and playback use the same soundfont, the same channel allocation and
 * the same percussion rules, so a rendered file matches what was heard. They
 * cannot share the *synth itself* — playback's lives in an `AudioWorklet` bound
 * to a realtime context, and Web Audio nodes do not cross contexts — so this
 * holds its own, built once per page by `offline-synth.ts`.
 *
 * Timing comes from the render loop rather than from an audio context: the
 * synth is asked for one small block at a time, and events falling inside that
 * block are dispatched just before it. Block size sets the timing resolution;
 * at 128 frames and 44.1kHz that is under three milliseconds, well below what
 * anyone hears as misplacement.
 *
 * The earlier version used `OfflineAudioContext.suspend()`, which worked but
 * needed a fresh context — and therefore a fresh worklet and a fresh 23MB font
 * load — for every single export.
 */
import type { DecodedAudio, RenderPlan } from '@sudobility/music_types';
import { allocateChannels } from '../playback/channel-allocator.js';
import type { ChannelAssignment } from '../playback/channel-allocator.js';
import { getOfflineSynth } from './offline-synth.js';
import type { LoadedOfflineSynth } from './offline-synth.js';

export type { RenderEvent, RenderPlan, RenderTrack } from '@sudobility/music_types';

export type SoundfontRendererAssets = {
  fluidsynthModuleUrl: string;
  fontUrl: string;
  loadFont: (url: string) => Promise<ArrayBuffer>;
  /** Overridable so tests can supply a stub synth instead of loading WASM. */
  acquireSynth?: (sampleRate: number) => Promise<LoadedOfflineSynth>;
};

const SAMPLE_RATE = 44100;
/** Release tail, so the last note is not cut off mid-decay. */
const TAIL_SECONDS = 1;
/** Timing resolution of the render: 128 frames is ~2.9ms at 44.1kHz. */
const BLOCK_FRAMES = 128;
const CC_VOLUME = 7;
const CC_PAN = 10;
const MAX_CC = 127;

type TimedEvent = { atFrame: number; run: () => void };

export function createSoundfontRenderer(
  assets: SoundfontRendererAssets,
): (plan: RenderPlan) => Promise<DecodedAudio> {
  const acquire =
    assets.acquireSynth ??
    ((sampleRate: number) =>
      getOfflineSynth({
        fluidsynthModuleUrl: assets.fluidsynthModuleUrl,
        fontUrl: assets.fontUrl,
        loadFont: assets.loadFont,
        sampleRate,
      }));

  return async function render(plan: RenderPlan): Promise<DecodedAudio> {
    const { synth, sfontId, sampleRate } = await acquire(SAMPLE_RATE);
    const totalFrames = Math.ceil(Math.max(0.1, plan.durationSec + TAIL_SECONDS) * sampleRate);

    // The synth is shared across exports, so it starts dirty: silence anything
    // still ringing and clear every channel's state before configuring.
    synth.midiAllSoundsOff();

    const { assignments } = allocateChannels(
      plan.tracks.map((t) => ({ id: t.id, isPercussion: t.isPercussion })),
    );
    const channelFor = new Map<string, ChannelAssignment>();
    for (const track of plan.tracks) {
      const assignment = assignments.get(track.id);
      if (!assignment) continue;
      channelFor.set(track.id, assignment);
      const { channel } = assignment;

      if (track.isPercussion || assignment.needsDrumTypeSwitch) {
        // Channel 9 is percussion already; anything else must be told. Never
        // select a program on either — it silences the channel.
        if (channel !== 9) synth.midiSetChannelType(channel, true);
      } else {
        synth.midiSetChannelType(channel, false);
        synth.midiProgramSelect(channel, sfontId, 0, track.midiProgram);
      }
      synth.midiControl(channel, CC_VOLUME, Math.round(track.volume * MAX_CC));
      synth.midiControl(channel, CC_PAN, panToCc(track.pan));
    }

    // Every note-on and note-off placed on the frame it falls due.
    const timeline: TimedEvent[] = [];
    for (const event of plan.events) {
      const assignment = channelFor.get(event.trackId);
      if (!assignment) continue; // an event for a track the plan never listed
      const { channel } = assignment;
      const velocity = Math.max(1, Math.min(MAX_CC, Math.round(event.velocity * MAX_CC)));
      timeline.push({
        atFrame: Math.round(event.startSec * sampleRate),
        run: () => synth.midiNoteOn(channel, event.midi, velocity),
      });
      timeline.push({
        atFrame: Math.round((event.startSec + event.durationSec) * sampleRate),
        run: () => synth.midiNoteOff(channel, event.midi),
      });
    }
    timeline.sort((a, b) => a.atFrame - b.atFrame);

    const samples = new Float32Array(totalFrames);
    const left = new Float32Array(BLOCK_FRAMES);
    const right = new Float32Array(BLOCK_FRAMES);
    let next = 0;

    for (let frame = 0; frame < totalFrames; frame += BLOCK_FRAMES) {
      const blockEnd = frame + BLOCK_FRAMES;
      while (next < timeline.length && timeline[next].atFrame < blockEnd) timeline[next++].run();

      synth.render([left, right]);

      // Mono mixdown, not just the left channel: a hard-panned track would
      // otherwise vanish from the export while being audible in playback.
      const count = Math.min(BLOCK_FRAMES, totalFrames - frame);
      for (let i = 0; i < count; i += 1) samples[frame + i] = (left[i] + right[i]) * 0.5;
    }

    synth.midiAllSoundsOff();
    return { samples, sampleRate };
  };
}

function panToCc(pan: number): number {
  return Math.round(((Math.min(1, Math.max(-1, pan)) + 1) / 2) * MAX_CC);
}
