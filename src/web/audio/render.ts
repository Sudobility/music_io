/**
 * Offline audio rendering.
 *
 * A thin loop over a plan somebody else decided on: `renderEvents` in music_lib
 * works out which tracks sound, when, and at what level, because those are
 * musical rules and belong somewhere testable without an audio context. All
 * that is left here is building the graph and scheduling into a `Tone.Offline`
 * render, which is the part that genuinely needs a browser.
 *
 * **The graph is deliberately the same one `tone-engine.ts` plays through**:
 * one instrument per track, resolved by the same `voiceSourceFor` rule, routed
 * through the track's own panner and gain into a master trimmed by the same
 * track-count headroom and capped by the same limiter. It used to be a flat
 * loop that shared one instrument per GM program, ignored `volume` and `pan`
 * entirely, and resolved the voice from `midiProgram` alone — so an exported
 * file had a different balance, and sometimes different instruments, from the
 * playback it was supposed to be a recording of.
 *
 * **Not unit tested, deliberately.** `Tone.Offline` needs a native
 * `OfflineAudioContext`, which vitest does not provide — a test here could
 * only assert against a mock agreeing with itself. Verification is the e2e
 * round trip: export a one-note score, decode the WAV, recover the pitch.
 */
import * as Tone from 'tone';
import type { DecodedAudio, RenderPlan } from '@sudobility/music_types';
import { createInstrument, voiceSourceFor } from '../playback/instruments/index.js';
import { headroomTrimFor, LIMITER_CEILING_DB } from '../playback/mix.js';

export type { RenderEvent, RenderPlan, RenderTrack } from '@sudobility/music_types';

export async function renderOffline(plan: RenderPlan): Promise<DecodedAudio> {
  const buffer = await Tone.Offline(() => {
    const limiter = new Tone.Limiter(LIMITER_CEILING_DB).toDestination();
    const master = new Tone.Gain(headroomTrimFor(plan.tracks.length));
    master.connect(limiter);

    // A channel per track, including any that turn out to have no events: the
    // headroom above is sized by the channel count, and playback counts them
    // the same way.
    const channels = new Map<string, ReturnType<typeof createInstrument>>();
    for (const track of plan.tracks) {
      const instrument = createInstrument(voiceSourceFor(track), track.isPercussion);
      const panner = new Tone.Panner(track.pan);
      const gain = new Tone.Gain(track.volume);
      instrument.connect(panner);
      panner.connect(gain);
      gain.connect(master);
      channels.set(track.id, instrument);
    }

    for (const event of plan.events) {
      const instrument = channels.get(event.trackId);
      if (!instrument) continue; // an event for a track the plan never listed
      instrument.triggerAttackRelease(event.midi, event.durationSec, event.startSec, event.velocity);
    }
    // Nothing is returned: Tone.Offline renders whatever was scheduled onto
    // the offline destination during this callback.
  }, Math.max(0.1, plan.durationSec));

  return { samples: buffer.getChannelData(0), sampleRate: buffer.sampleRate };
}
