/**
 * React Native platform implementations. Metro resolves these through the
 * `react-native` branch of this package's export condition, so app code imports
 * `@sudobility/music_io` and never branches on platform.
 */
import { RNPlaybackEngine } from './playback/playback.rn.js';
import { RNXmlParser } from './xml/xml.rn.js';
import { RNFileExporter } from './file/file.rn.js';
import { ToneJsMidiCodec } from '../shared/midi/codec.tonejs.js';
import { SharedModCodec } from '../shared/mod/codec.js';
import { createRNAudioCodec } from './audio-codec.js';
import type { MusicIo } from '../shared/types.js';

export { RNPlaybackEngine, RNXmlParser, RNFileExporter, ToneJsMidiCodec };
export type { MusicIo };

export function createMusicIo(): MusicIo {
  return {
    playback: new RNPlaybackEngine(),
    xmlParser: new RNXmlParser(),
    // The same codec as web: Standard MIDI File encoding is byte manipulation
    // with no platform APIs in it.
    midiCodec: new ToneJsMidiCodec(),
    modCodec: new SharedModCodec(),
    audioCodec: createRNAudioCodec(),
    audioRenderer: {
      // No audio context here; rendering is a browser capability.
      render: () => Promise.reject(new Error('Offline audio rendering is not available on this platform')),
    },
    fileExporter: new RNFileExporter(),
  };
}
