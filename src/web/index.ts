/**
 * Web platform implementations. Resolved by any bundler that is not Metro,
 * through the `default` branch of this package's export condition.
 */
import { TonePlaybackEngine } from './playback/tone-engine.js';
import { WebXmlParser } from './xml/xml.web.js';
import { WebFileExporter } from './file/file.web.js';
import { ToneJsMidiCodec } from '../shared/midi/codec.tonejs.js';
import { SharedModCodec } from '../shared/mod/codec.js';
import { createWebAudioCodec } from './audio/web-audio-codec.js';
import { renderOffline } from './audio/render.js';
export { renderOffline } from './audio/render.js';
export type { RenderEvent } from './audio/render.js';
import type { MusicIo } from '../shared/types.js';

export { TonePlaybackEngine, WebXmlParser, WebFileExporter, ToneJsMidiCodec };
export * from './playback/instruments/index.js';
export * from './playback/schedule.js';
export * from './playback/midi.js';
export type { MusicIo };

/** Everything the web platform provides, built fresh. */
export function createMusicIo(): MusicIo {
  return {
    playback: new TonePlaybackEngine(),
    xmlParser: new WebXmlParser(),
    midiCodec: new ToneJsMidiCodec(),
    modCodec: new SharedModCodec(),
    audioCodec: createWebAudioCodec(),
    audioRenderer: { render: renderOffline },
    fileExporter: new WebFileExporter(),
  };
}
