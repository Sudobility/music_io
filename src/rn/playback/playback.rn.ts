import * as Tone from 'tone';
import { AudioContext } from 'react-native-audio-api';
import { TonePlaybackEngine } from '../../web/playback/tone-engine.js';

/**
 * Tone.js driven by `react-native-audio-api`'s Web Audio implementation.
 *
 * **Unverified on a device.** `react-native-audio-api` requires `react-native`
 * at import time, so there is no JS-only build to test this against — see
 * `spikes/tone-on-rn-audio-api.md` for the full finding. What is established:
 * every Web Audio node these synths compile down to is implemented, and the two
 * gaps (`AudioWorklet`, `DynamicsCompressorNode`) are needed only by Tone's
 * `BitCrusher` and `FeedbackCombFilter`, neither of which we use. Tone's
 * transport clock falls back to `setTimeout` where there is no Web Worker,
 * which is React Native's situation.
 *
 * Reusing the Tone engine rather than writing a synthesis engine from scratch
 * is a deliberate bet, and a cheap one to lose: if a device test shows Tone
 * will not run here, replacing this class with a direct
 * `react-native-audio-api` implementation of `PlaybackEngine` touches this file
 * and nothing in music_lib or music_app. That reversibility is the whole reason
 * playback sits behind an interface.
 */
export class RNPlaybackEngine extends TonePlaybackEngine {
  override async initialize(): Promise<void> {
    // Point Tone at the native audio context before anything builds a node on
    // the default one, which does not exist here.
    Tone.setContext(new AudioContext() as unknown as Parameters<typeof Tone.setContext>[0]);
    await super.initialize();
  }
}
