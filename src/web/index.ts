/**
 * Web platform implementations. Resolved by any bundler that is not Metro,
 * through the `default` branch of this package's export condition.
 */
import { createWebMidiInput } from './midi/web-midi-input.js';
import { WebXmlParser } from './xml/xml.web.js';
import { WebFileExporter } from './file/file.web.js';
import { createWebAudioCodec } from './audio/web-audio-codec.js';
import { createSoundfontRenderer } from './audio/soundfont-render.js';
import { SoundfontPlaybackEngine } from './playback/soundfont-engine.js';
import { loadSoundfont, openSoundfontCache } from './playback/soundfont-loader.js';
import { SynthHost } from './playback/synth-host.js';
import type { SynthInstance } from './playback/synth-host.js';
import type { MusicIo } from '../shared/types.js';

export { WebXmlParser, WebFileExporter };
export * from '../shared/playback/midi.js';
export type { MusicIo };

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

/**
 * Where the soundfont engine's assets are served from.
 *
 * Passed in rather than resolved here: this is a library and cannot assume how
 * a consuming app serves files out of `node_modules`. The worklet modules in
 * particular must be reachable as URLs, because `addModule` takes a URL.
 *
 * Required, not optional: the soundfont synth is the only engine. There is no
 * silent fallback to be had, and an app that has not hosted the assets should
 * fail loudly at wiring time rather than mysteriously play nothing.
 */
export type SoundfontAssets = {
  /** The `-with-libsndfile` build. The plain one cannot read SF3. */
  fluidsynthModuleUrl: string;
  workletModuleUrl: string;
  fontUrl: string;
};

/** Everything the web platform provides, built fresh. */
export function createMusicIo({
  soundfont,
}: {
  soundfont: SoundfontAssets;
}): MusicIo {
  return {
    playback: new SoundfontPlaybackEngine({
      host: new SynthHost({ createSynth: createWorkletSynth }),
      moduleUrls: { fluidsynth: soundfont.fluidsynthModuleUrl, worklet: soundfont.workletModuleUrl },
      fontUrl: soundfont.fontUrl,
    }),
    xmlParser: new WebXmlParser(),
    audioCodec: createWebAudioCodec(),
    // Export goes through the same soundfont as playback, so the two cannot drift.
    audioRenderer: {
      render: createSoundfontRenderer({
        fluidsynthModuleUrl: soundfont.fluidsynthModuleUrl,
        fontUrl: soundfont.fontUrl,
        loadFont: async (url) => loadSoundfont(url, { cache: await openSoundfontCache() }),
      }),
    },
    midiInput: createWebMidiInput(),
    fileExporter: new WebFileExporter(),
  };
}
