/**
 * React Native platform implementations. Metro resolves these through the
 * `react-native` branch of this package's export condition, so app code imports
 * `@sudobility/music_io` and never branches on platform.
 */
import { RNXmlParser } from './xml/xml.rn.js';
import { RNFileExporter } from './file/file.rn.js';
import { ToneJsMidiCodec } from '../shared/midi/codec.tonejs.js';
import { SharedModCodec } from '../shared/mod/codec.js';
import { createRNAudioCodec } from './audio-codec.js';
import type { MusicIo } from '../shared/types.js';
import type { PlaybackEngine } from '@sudobility/music_types';

export { RNXmlParser, RNFileExporter, ToneJsMidiCodec };
export type { MusicIo };

/**
 * A `PlaybackEngine` that refuses rather than pretends.
 *
 * Playback needs the soundfont synth, which runs libfluidsynth in an
 * AudioWorklet — a browser capability with no React Native equivalent. The
 * engine that used to be here synthesised its own approximations of the
 * instruments and so could never match what the web plays; a wrong sound is
 * worse than a clear error. Query methods stay silent no-ops so a shared
 * component that calls `pause()` on unmount does not crash the app; anything
 * that would actually make a sound throws.
 */
function unavailablePlayback(): PlaybackEngine {
  const refuse = (): never => {
    throw new Error('Playback is not available on this platform');
  };
  const ignore = (): void => {};
  return {
    initialize: refuse,
    loadScore: refuse,
    play: refuse,
    noteOn: refuse,
    pause: ignore,
    stop: ignore,
    seek: ignore,
    setTempoMultiplier: ignore,
    setLoop: ignore,
    setTrackMute: ignore,
    setTrackSolo: ignore,
    setMetronome: ignore,
    setMasterVolume: ignore,
    noteOff: ignore,
    setObserver: ignore,
    dispose: ignore,
  };
}

export function createMusicIo(): MusicIo {
  return {
    // Playback is a browser capability here: it needs the soundfont synth,
    // which runs in an AudioWorklet. React Native has no equivalent, and the
    // previous Tone-based engine could not play a soundfont at all.
    playback: unavailablePlayback(),
    xmlParser: new RNXmlParser(),
    // The same codec as web: Standard MIDI File encoding is byte manipulation
    // with no platform APIs in it.
    midiCodec: new ToneJsMidiCodec(),
    modCodec: new SharedModCodec(),
    audioCodec: createRNAudioCodec(),
    audioRenderer: {
      // No audio context here; rendering is a browser capability.
      render: () => Promise.reject(new Error('Offline audio rendering is not available on this platform')),
    },
    audioTranscriber: {
      // The model and its tensor runtime are web-only. Callers fall back to
      // music_lib's pure YIN tracker, which is monophonic but needs nothing.
      transcribe: () =>
        Promise.reject(new Error('Audio transcription is not available on this platform')),
    },
    fileExporter: new RNFileExporter(),
  };
}
