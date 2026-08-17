import type {
  AudioCodec,
  AudioRenderer,
  FileExporter,
  MidiCodec,
  TrackerCodec,
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
  /** Named `modCodec` still, for now: renaming it reaches into music_app and belongs with the change that widens the accepted extensions. */
  modCodec: TrackerCodec;
  audioCodec: AudioCodec;
  audioRenderer: AudioRenderer;
  fileExporter: FileExporter;
};
