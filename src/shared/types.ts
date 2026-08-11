import type {
  AudioTranscriber,
  AudioCodec,
  AudioRenderer,
  FileExporter,
  MidiCodec,
  ModCodec,
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
  modCodec: ModCodec;
  audioCodec: AudioCodec;
  audioRenderer: AudioRenderer;
  audioTranscriber: AudioTranscriber;
  fileExporter: FileExporter;
};
