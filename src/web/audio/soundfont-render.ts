/**
 * Offline audio rendering through the same synth playback uses.
 *
 * The point is that export cannot drift from playback. The Tone renderer this
 * replaces was a second graph that had to be kept in agreement by hand, and it
 * silently fell out of agreement — ignoring per-track volume and pan, and
 * resolving instruments by a different rule, so an exported file had a
 * different balance and sometimes different instruments from the playback it
 * was supposed to be a recording of. Here there is one engine and one channel
 * setup, so agreement is structural.
 *
 * Timing comes from `OfflineAudioContext.suspend()`: rendering pauses at each
 * moment an event falls due, the events are dispatched, and rendering resumes.
 * Without it every note would sound at t=0, because the synth applies MIDI
 * events the moment it receives them.
 *
 * **Not unit tested, deliberately.** `OfflineAudioContext` and `AudioWorklet`
 * are browser capabilities vitest does not provide; a test here could only
 * assert that a mock agrees with itself. Verification is the round trip:
 * export a WAV and listen to it.
 */
import type { DecodedAudio, RenderPlan } from '@sudobility/music_types';
import { allocateChannels } from '../playback/channel-allocator.js';
import type { ChannelAssignment } from '../playback/channel-allocator.js';
import { SynthHost } from '../playback/synth-host.js';
import type { SynthInstance } from '../playback/synth-host.js';

export type { RenderEvent, RenderPlan, RenderTrack } from '@sudobility/music_types';

export type SoundfontRendererAssets = {
  fluidsynthModuleUrl: string;
  workletModuleUrl: string;
  fontUrl: string;
  loadFont: (url: string) => Promise<ArrayBuffer>;
  createSynth: () => SynthInstance | Promise<SynthInstance>;
};

const SAMPLE_RATE = 44100;
/** Release tail so the last note is not cut off mid-decay. */
const TAIL_SECONDS = 1;

type TimedEvent = { atSeconds: number; run: () => void };

export function createSoundfontRenderer(
  assets: SoundfontRendererAssets,
): (plan: RenderPlan) => Promise<DecodedAudio> {
  return async function render(plan: RenderPlan): Promise<DecodedAudio> {
    const seconds = Math.max(0.1, plan.durationSec + TAIL_SECONDS);
    const context = new OfflineAudioContext({
      numberOfChannels: 2,
      length: Math.ceil(SAMPLE_RATE * seconds),
      sampleRate: SAMPLE_RATE,
    });

    const host = new SynthHost({ createSynth: assets.createSynth });
    const { assignments, instanceCount } = allocateChannels(
      plan.tracks.map((t) => ({ id: t.id, isPercussion: t.isPercussion })),
    );
    await host.init(context, {
      fluidsynthModuleUrl: assets.fluidsynthModuleUrl,
      workletModuleUrl: assets.workletModuleUrl,
      soundfont: await assets.loadFont(assets.fontUrl),
      instanceCount,
    });

    // Same channel setup as playback: percussion channels are marked and never
    // program-selected, everything else takes its GM program, volume and pan.
    const channelFor = new Map<string, ChannelAssignment>();
    for (const track of plan.tracks) {
      const assignment = assignments.get(track.id);
      if (!assignment) continue;
      channelFor.set(track.id, assignment);
      if (track.isPercussion || assignment.needsDrumTypeSwitch) {
        host.setChannelPercussion(assignment.instance, assignment.channel);
      } else {
        host.programSelect(assignment.instance, assignment.channel, track.midiProgram);
      }
      host.controlChange(assignment.instance, assignment.channel, 7, Math.round(track.volume * 127));
      host.controlChange(
        assignment.instance,
        assignment.channel,
        10,
        Math.round(((Math.min(1, Math.max(-1, track.pan)) + 1) / 2) * 127),
      );
    }
    host.setTrackCount(plan.tracks.length);

    // Every note-on and note-off as a timed event, in time order.
    const timeline: TimedEvent[] = [];
    for (const event of plan.events) {
      const assignment = channelFor.get(event.trackId);
      if (!assignment) continue; // an event for a track the plan never listed
      const velocity = Math.max(1, Math.min(127, Math.round(event.velocity * 127)));
      timeline.push({
        atSeconds: event.startSec,
        run: () => host.noteOn(assignment.instance, assignment.channel, event.midi, velocity),
      });
      timeline.push({
        atSeconds: event.startSec + event.durationSec,
        run: () => host.noteOff(assignment.instance, assignment.channel, event.midi),
      });
    }
    timeline.sort((a, b) => a.atSeconds - b.atSeconds);

    // Suspend at each distinct moment, dispatch, resume. This is what gives the
    // render its timing; the synth itself applies events immediately.
    let index = 0;
    while (index < timeline.length) {
      const at = timeline[index].atSeconds;
      const batch: TimedEvent[] = [];
      while (index < timeline.length && timeline[index].atSeconds === at) batch.push(timeline[index++]);
      if (at <= 0) {
        for (const event of batch) event.run();
        continue;
      }
      if (at >= seconds) break; // past the end of the render
      void context.suspend(at).then(() => {
        for (const event of batch) event.run();
        void context.resume();
      });
    }

    const buffer = await context.startRendering();
    host.dispose();
    return { samples: buffer.getChannelData(0), sampleRate: buffer.sampleRate };
  };
}
