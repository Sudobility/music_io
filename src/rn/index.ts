/**
 * React Native platform implementations. Metro resolves these through the
 * `react-native` branch of this package's export condition, so app code imports
 * `@sudobility/music_io` and never branches on platform.
 */
import { RNXmlParser } from './xml/xml.rn.js';
import { RNFileExporter } from './file/file.rn.js';
import { ToneJsMidiCodec } from '../shared/midi/codec.tonejs.js';
import { SharedModCodec } from '../shared/mod/codec.js';
import { createRNAudioCodec } from './audio-codec.js';
import { RNSamplePlaybackEngine } from './playback/sample-engine.js';
import { createRNSoundfontRenderer } from './audio/offline-render.js';
import type { SampleEngineDeps } from './playback/sample-engine.js';
import type { MusicIo } from '../shared/types.js';

export { RNXmlParser, RNFileExporter, ToneJsMidiCodec, RNSamplePlaybackEngine, createRNSoundfontRenderer };
export type { MusicIo, SampleEngineDeps };

export type RNMusicIoOptions = {
  /**
   * Where the melodic FluidR3 packs are served from.
   *
   * Defaults to the packs' own GitHub Pages host. An app that would rather not
   * depend on a third party at runtime can copy them and point this at its own
   * CDN — they are CC-BY 3.0, so that is allowed, and it is the recommended
   * setup for anything shipping to a store.
   */
  packBase?: string;
  /**
   * Where the drum-kit packs are served from. **Required for percussion**;
   * there is no default because nobody publishes usably-licensed GM percussion.
   * Render them with `scripts/build-percussion-packs.mjs` and host them the way
   * the web app hosts its soundfont.
   */
  percussionBase?: string;
};

/**
 * Everything React Native provides.
 *
 * Playback is a sample-based FluidR3 engine rather than the web's
 * libfluidsynth-in-an-AudioWorklet — React Native has neither WebAssembly nor
 * `addModule`, so that engine cannot be ported, only replaced. It is replaced
 * with the *same font*, pre-rendered per note, so a phone plays the recordings
 * a browser plays. See `playback/sample-engine.ts` and
 * `spikes/rn-sample-playback.md`.
 */
export function createMusicIo(options: RNMusicIoOptions = {}): MusicIo {
  return {
    playback: new RNSamplePlaybackEngine({
      packBase: options.packBase,
      percussionBase: options.percussionBase,
    }),
    xmlParser: new RNXmlParser(),
    // The same codec as web: Standard MIDI File encoding is byte manipulation
    // with no platform APIs in it.
    midiCodec: new ToneJsMidiCodec(),
    modCodec: new SharedModCodec(),
    // Decoding borrows the OS decoder through `react-native-audio-api`; both
    // encoders are pure JS in `shared/`.
    audioCodec: createRNAudioCodec(),
    // The same samples playback uses, scheduled up front against an
    // OfflineAudioContext so an export renders as fast as the device manages
    // rather than in real time. Sharing `PackLibrary` and `planVoice` with the
    // engine is what keeps the file a recording of what was heard.
    audioRenderer: createRNSoundfontRenderer({
      packBase: options.packBase,
      percussionBase: options.percussionBase,
    }),
    fileExporter: new RNFileExporter(),
  };
}
