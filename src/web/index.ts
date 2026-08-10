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
import { SoundfontPlaybackEngine } from './playback/soundfont-engine.js';
import { SynthHost } from './playback/synth-host.js';
import type { SynthInstance } from './playback/synth-host.js';
export { renderOffline } from './audio/render.js';
export type { RenderEvent } from './audio/render.js';
import type { MusicIo } from '../shared/types.js';

export { TonePlaybackEngine, WebXmlParser, WebFileExporter, ToneJsMidiCodec };
export * from './playback/instruments/index.js';
export * from './playback/schedule.js';
export * from './playback/midi.js';
export type { MusicIo };

/** Everything the web platform provides, built fresh. */
/**
 * Where the soundfont engine's assets are served from.
 *
 * Passed in rather than resolved here: this is a library and cannot assume how
 * a consuming app serves files out of `node_modules`. The worklet modules in
 * particular must be reachable as URLs, because `addModule` takes a URL.
 *
 * Omit it and playback falls back to the Tone engine, so an app that has not
 * hosted the assets yet still works.
 */
/**
 * Builds one real `AudioWorkletNodeSynthesizer`.
 *
 * The only place `js-synthesizer` is constructed, and the import is lazy so an
 * app that never enables the soundfont engine does not pull it in. Async by
 * design: a synchronous factory would need the module loaded first, and a
 * caller forgetting that step would fail at init with no sound and no obvious
 * cause — the failure shape this engine exists to remove.
 */
async function createWorkletSynth(): Promise<SynthInstance> {
  const { AudioWorkletNodeSynthesizer } = await import('js-synthesizer');
  return new AudioWorkletNodeSynthesizer() as unknown as SynthInstance;
}

export type SoundfontAssets = {
  /** The `-with-libsndfile` build. The plain one cannot read SF3. */
  fluidsynthModuleUrl: string;
  workletModuleUrl: string;
  fontUrl: string;
};

export function createMusicIo(options: { soundfont?: SoundfontAssets } = {}): MusicIo {
  const soundfont = options.soundfont;
  return {
    playback: soundfont
      ? new SoundfontPlaybackEngine({
          host: new SynthHost({ createSynth: createWorkletSynth }),
          moduleUrls: { fluidsynth: soundfont.fluidsynthModuleUrl, worklet: soundfont.workletModuleUrl },
          fontUrl: soundfont.fontUrl,
        })
      : new TonePlaybackEngine(),
    xmlParser: new WebXmlParser(),
    midiCodec: new ToneJsMidiCodec(),
    modCodec: new SharedModCodec(),
    audioCodec: createWebAudioCodec(),
    audioRenderer: { render: renderOffline },
    fileExporter: new WebFileExporter(),
  };
}
