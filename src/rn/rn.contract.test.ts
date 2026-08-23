import { runPlatformContract } from '../contract/platform-contract.js';
import { createMusicIo } from './index.js';

/**
 * The RN entry needs no native module faked, because it imports none eagerly:
 * `react-native-audio-api` is loaded on first use inside the engine, so the
 * whole entry constructs in a plain Node process.
 *
 * `playback: 'accepts'` now — the sample engine is real. What the contract
 * proves is still bounded, and worth being precise about: the engine's
 * *transport* is covered in depth by `playback/sample-engine.test.ts` against a
 * fake audio graph, but nothing here or there proves sound comes out of a
 * speaker. That needs a device, as it always will for React Native audio.
 *
 * Offline render is `'renders'` too now: it schedules the whole plan up front
 * against an `OfflineAudioContext` and shares `PackLibrary` and `planVoice`
 * with the engine, so an export is voiced identically to what was heard.
 */
runPlatformContract('rn', createMusicIo);
