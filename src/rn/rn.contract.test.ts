import { vi } from 'vitest';
import { runPlatformContract } from '../contract/platform-contract.js';

/**
 * `react-native-audio-api` requires `react-native` at import time and has no
 * JS-only build, so it is faked here. That is a real limit on what this proves:
 * the XML, MIDI and interface-shape guarantees are genuinely exercised, but
 * whether Tone.js actually produces sound on the native context is **not**
 * verified by this file and cannot be without a device. See
 * `spikes/tone-on-rn-audio-api.md`.
 */
vi.mock('react-native-audio-api', () => ({
  AudioContext: class {
    readonly currentTime = 0;
    readonly destination = {};
    close(): void {}
    resume(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

const { createMusicIo } = await import('./index.js');

runPlatformContract('rn', createMusicIo);
