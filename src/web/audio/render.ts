/**
 * Offline audio rendering.
 *
 * A thin loop over events somebody else decided on: `renderEvents` in
 * music_lib works out which tracks sound, when, and how loudly, because those
 * are musical rules and belong somewhere testable without an audio context.
 * All that is left here is scheduling them into a `Tone.Offline` render, which
 * is the part that genuinely needs a browser.
 *
 * The instruments are the *same* `createInstrument` playback uses, so an
 * exported file sounds like what you just heard rather than merely similar.
 *
 * **Not unit tested, deliberately.** `Tone.Offline` needs a native
 * `OfflineAudioContext`, which vitest does not provide — a test here could
 * only assert against a mock agreeing with itself. Verification is the e2e
 * round trip: export a one-note score, decode the WAV, recover the pitch.
 */
import * as Tone from 'tone';
import type { DecodedAudio } from '@sudobility/music_types';
import { createInstrument } from '../playback/instruments.js';

/**
 * One note to sound. Structurally identical to music_lib's `RenderEvent`;
 * declared here so music_io keeps no dependency on music_lib.
 */
export type RenderEvent = {
  midi: number;
  startSec: number;
  durationSec: number;
  velocity: number;
  midiProgram: number;
  isPercussion: boolean;
};

/** Instruments are shared per program, not created per note — one synth per voice. */
function instrumentKey(event: RenderEvent): string {
  return `${event.midiProgram}:${event.isPercussion ? 'perc' : 'pitched'}`;
}

export async function renderOffline(
  events: readonly RenderEvent[],
  durationSec: number,
): Promise<DecodedAudio> {
  const buffer = await Tone.Offline(() => {
    const instruments = new Map<string, ReturnType<typeof createInstrument>>();
    for (const event of events) {
      const key = instrumentKey(event);
      let instrument = instruments.get(key);
      if (!instrument) {
        instrument = createInstrument(event.midiProgram, event.isPercussion);
        instruments.set(key, instrument);
      }
      instrument.triggerAttackRelease(
        event.midi,
        event.durationSec,
        event.startSec,
        event.velocity,
      );
    }
    // Nothing is returned: Tone.Offline renders whatever was scheduled onto
    // the offline destination during this callback.
  }, Math.max(0.1, durationSec));

  return { samples: buffer.getChannelData(0), sampleRate: buffer.sampleRate };
}
