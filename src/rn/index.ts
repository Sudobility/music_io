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
// Platform-free, and identical on every entry: what a recording import offers.
export * from "../shared/audio-import.js";

/**
 * Everything React Native provides.
 *
 * Playback left with the music_player split; the sample-based FluidR3 engine
 * and its pack options live there now. What is here is bytes: audio decoding
 * through the OS, XML, the filesystem, and MIDI input (which React Native has
 * none of, so it reports `isSupported()` false).
 */
/** What the host has to tell this bundle, because it cannot reliably ask. */
export type MusicIoOptions = {
  /**
   * Whether this platform's share sheet can actually take a file.
   *
   * The host decides, in the same spirit as `setErrorLogging(DEV)`: a library
   * that sniffs its environment is the thing this family avoids. It matters
   * because macOS fails *silently* — `react-native-share` imports fine there
   * and `open()` resolves without doing anything, so there is no error for the
   * exporter to catch and the file ends up in a cache directory nobody
   * browses. Passing `false` makes `save` write a real file instead, which is
   * the right desktop behaviour anyway: the share sheet only exists because
   * iOS has no filesystem the user browses.
   *
   * Defaults to true, so iOS and Android need say nothing.
   */
  shareSheet?: boolean;
};

export function createMusicIo(options: MusicIoOptions = {}): MusicIo {
  const xmlParser = new RNXmlParser();
  // The same codec as web: Standard MIDI File encoding is byte manipulation
  // with no platform APIs in it. Decoding borrows the OS decoder through
  // `react-native-audio-api`; both encoders are pure JS in `shared/`.
  const audioCodec = createRNAudioCodec();
  const fileExporter = new RNFileExporter(
    options.shareSheet === false ? { shareSheet: false } : {},
  );
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
