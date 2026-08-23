import type {
  AudioCodec,
  AudioRenderer,
  FileExporter,
  MidiInput,
  PlaybackEngine,
  XmlParser,
} from '@sudobility/music_types';

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
 * What is left genuinely needs a platform: sampled audio, playback, the
 * filesystem, XML (whose two implementations really do differ), and MIDI
 * *input*, which is a device rather than a file.
 */
export type MusicIo = {
  playback: PlaybackEngine;
  xmlParser: XmlParser;
  audioCodec: AudioCodec;
  audioRenderer: AudioRenderer;
  fileExporter: FileExporter;
  /** Live MIDI keyboard input. A platform without ports reports `isSupported()` false. */
  midiInput: MidiInput;
};
