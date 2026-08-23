/**
 * Web platform implementations. Resolved by any bundler that is not Metro,
 * through the `default` branch of this package's export condition.
 */
import { createWebMidiInput } from './midi/web-midi-input.js';
import { WebXmlParser } from './xml/xml.web.js';
import { WebFileExporter } from './file/file.web.js';
import { createWebAudioCodec } from './audio/web-audio-codec.js';
import { createScoreFiles } from '../shared/score-files.js';
import type { MusicIo } from '../shared/types.js';

export { WebXmlParser, WebFileExporter };
export type { MusicIo };

/** Everything the web platform provides, built fresh. */
export function createMusicIo(): MusicIo {
  const xmlParser = new WebXmlParser();
  const audioCodec = createWebAudioCodec();
  const fileExporter = new WebFileExporter();
  return {
    xmlParser,
    audioCodec,
    fileExporter,
    midiInput: createWebMidiInput(),
    // The open/save layer, built from the three capabilities above — see
    // `shared/score-files.ts` for why it lives on this bundle at all.
    ...createScoreFiles({ xmlParser, audioCodec, fileExporter }),
  };
}
