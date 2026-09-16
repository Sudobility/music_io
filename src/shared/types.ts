import type { ScoreFiles } from "@sudobility/music_types";
import type {
  AudioCodec,
  FileExporter,
  MidiInput,
  XmlParser,
} from "@sudobility/music_types";

/**
 * Everything a platform provides. Each entry point (`web`, `rn`, `mocks`)
 * exports a `createMusicIo()` returning one of these, so app code is identical
 * whichever platform resolved.
 *
 * Score formats are deliberately absent. MIDI files and tracker modules are
 * byte arithmetic against a published spec — no audio context, no DOM — so
 * they live in `@sudobility/music_codecs` and are imported directly rather
 * than injected. They were here because the app reached every file format
 * through one seam, which cost four hand-copied MIDI codecs and put a pure
 * byte reader out of the server's reach.
 *
 * Playback is deliberately absent too, as of the music_player split. Making
 * sound needs a platform, but it is a large enough job to be its own package —
 * and it was previously split across three, with the engines here and the
 * transport in music_lib reading the store. Audio *export* renders there as
 * well and hands back PCM; this package encodes and writes it, which is why it
 * needs no reference to a running synth.
 *
 * What is left genuinely needs a platform and is genuinely about bytes: audio
 * encoding, the filesystem, XML (whose two implementations really do differ),
 * and MIDI *input*, which is a device rather than a file.
 *
 * **`ScoreFiles` is the one thing here that is not a capability.** Its eight
 * `open*`/`save*` methods are orchestration — a codec call paired with a file
 * write — that happens to need two of the capabilities below. They live on this
 * bundle so the app makes one call per import or export instead of assembling
 * the pair itself, which is what it used to do in four near-identical export
 * handlers. Worth knowing when reading "everything a platform provides": these
 * are provided *by* the platform's pieces, not *by* the platform.
 */
export type MusicIo = ScoreFiles & {
  xmlParser: XmlParser;
  audioCodec: AudioCodec;
  fileExporter: FileExporter;
  /** Live MIDI keyboard input. A platform without ports reports `isSupported()` false. */
  midiInput: MidiInput;
};
