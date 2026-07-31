/**
 * Web platform implementations. Resolved by any bundler that is not Metro,
 * via the `default` branch of this package's export condition.
 */
import { TonePlaybackEngine } from './playback/tone-engine.js';
import type { MusicIo } from '../shared/types.js';

export { TonePlaybackEngine };
export * from './playback/instruments.js';
export * from './playback/schedule.js';
export * from './playback/midi.js';
export type { MusicIo };

export function createMusicIo(): MusicIo {
  throw new Error('createMusicIo: the web entry is completed in Tasks 5 and 6');
}
