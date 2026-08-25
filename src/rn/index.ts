/**
 * React Native platform implementations. Metro resolves these through the
 * `react-native` branch of this package's export condition, so app code imports
 * `@sudobility/music_io` and never branches on platform.
 */
import { createUnsupportedMidiInput } from "../shared/midi/unsupported-midi-input.js";
import { RNXmlParser } from "./xml/xml.rn.js";
import { RNFileExporter } from "./file/file.rn.js";
import { createRNAudioCodec } from "./audio-codec.js";
import { createScoreFiles } from "../shared/score-files.js";
import type { MusicIo } from "../shared/types.js";

export { RNXmlParser, RNFileExporter };
export type { MusicIo };

/**
 * Everything React Native provides.
 *
 * Playback left with the music_player split; the sample-based FluidR3 engine
 * and its pack options live there now. What is here is bytes: audio decoding
 * through the OS, XML, the filesystem, and MIDI input (which React Native has
 * none of, so it reports `isSupported()` false).
 */
export function createMusicIo(): MusicIo {
  const xmlParser = new RNXmlParser();
  // The same codec as web: Standard MIDI File encoding is byte manipulation
  // with no platform APIs in it. Decoding borrows the OS decoder through
  // `react-native-audio-api`; both encoders are pure JS in `shared/`.
  const audioCodec = createRNAudioCodec();
  const fileExporter = new RNFileExporter();
  return {
    xmlParser,
    audioCodec,
    fileExporter,
    midiInput: createUnsupportedMidiInput(),
    // The open/save layer, built from the three capabilities above — see
    // `shared/score-files.ts` for why it lives on this bundle at all.
    ...createScoreFiles({ xmlParser, audioCodec, fileExporter }),
  };
}
