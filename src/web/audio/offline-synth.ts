/**
 * A long-lived synth for offline rendering, loaded once per page.
 *
 * Export cannot share playback's synth: Web Audio nodes belong to the context
 * that created them, playback runs on a realtime `AudioContext`, and rendering
 * faster than realtime needs an `OfflineAudioContext`. Nothing bridges the two.
 * Worse, an `OfflineAudioContext` renders exactly once, so the previous design
 * built a fresh worklet and reloaded the 23MB soundfont on *every export* —
 * about five seconds each time, with libfluidsynth's build-stub notices along
 * for the ride.
 *
 * `Synthesizer.render()` avoids all of it by needing no audio context at all:
 * it fills buffers straight from the WASM synth. So one synth is built, the
 * font is loaded into it once, and every export after the first is immediate.
 *
 * This one runs on the main thread rather than in a worklet, which is fine
 * precisely because it is offline — there is no audio callback to starve.
 */
import { seedMainThreadQuietModule } from '../playback/quiet-stub-notices.js';
import type { SynthesizerLike } from './synth-types.js';

/** Resolves once `libfluidsynth-*.js` has been loaded and its WASM is ready. */
let fluidsynthReady: Promise<void> | null = null;
/** The loaded synth, keyed so a changed font or rate rebuilds rather than lying. */
let cached: { key: string; synth: Promise<LoadedOfflineSynth> } | null = null;

export type LoadedOfflineSynth = {
  synth: SynthesizerLike;
  sfontId: number;
  sampleRate: number;
};

/**
 * Loads libfluidsynth into the *main thread*.
 *
 * A script tag rather than `addModule`: the non-worklet synth reads the module
 * from the global scope, where `addModule` would put it inside the worklet
 * instead. Memoised, since loading it twice would replace the global mid-flight.
 */
async function ensureFluidsynth(moduleUrl: string): Promise<void> {
  fluidsynthReady ??= (async () => {
    if (typeof document === 'undefined') {
      throw new Error('Offline rendering needs a document to load libfluidsynth');
    }
    // Before the script runs: emscripten reads the global Module on load.
    seedMainThreadQuietModule();
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = moduleUrl;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${moduleUrl}`));
      document.head.appendChild(script);
    });
    const jsSynth = await import('js-synthesizer');
    await jsSynth.waitForReady();
  })();
  return fluidsynthReady;
}

export type OfflineSynthRequest = {
  fluidsynthModuleUrl: string;
  fontUrl: string;
  loadFont: (url: string) => Promise<ArrayBuffer>;
  sampleRate: number;
};

/** The shared offline synth, building it on first use. */
export async function getOfflineSynth(request: OfflineSynthRequest): Promise<LoadedOfflineSynth> {
  const key = `${request.fluidsynthModuleUrl}|${request.fontUrl}|${request.sampleRate}`;
  if (cached?.key === key) return await cached.synth;

  const building = (async (): Promise<LoadedOfflineSynth> => {
    await ensureFluidsynth(request.fluidsynthModuleUrl);
    const jsSynth = await import('js-synthesizer');
    const synth = new jsSynth.Synthesizer() as unknown as SynthesizerLike;
    synth.init(request.sampleRate);
    const sfontId = await synth.loadSFont(await request.loadFont(request.fontUrl));
    return { synth, sfontId, sampleRate: request.sampleRate };
  })();

  cached = { key, synth: building };
  try {
    return await building;
  } catch (error) {
    cached = null; // a failed build must not be handed to the next caller
    throw error;
  }
}

/** Drops the shared synth. Exposed for tests and teardown, not used in normal flow. */
export function releaseOfflineSynth(): void {
  cached = null;
}
