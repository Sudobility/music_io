import type {
  AudioCodec,
  AudioRenderer,
  FileExporter,
  MidiCodec,
  PlaybackEngine,
  XmlParser,
} from '@sudobility/music_types';

/**
 * Everything a platform provides. Each entry point (`web`, `rn`, `mocks`)
 * exports a `createMusicIo()` returning one of these, so app code is identical
 * whichever platform resolved.
 */
export type MusicIo = {
  playback: PlaybackEngine;
  xmlParser: XmlParser;
  midiCodec: MidiCodec;
  audioCodec: AudioCodec;
  audioRenderer: AudioRenderer;
  fileExporter: FileExporter;
};
