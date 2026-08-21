/**
 * Test doubles for every platform service.
 *
 * Shipped from the package rather than duplicated in each consumer, so
 * music_lib's and music_app's tests exercise the same fakes this package's own
 * contract suite does.
 */
import { createUnsupportedMidiInput } from '../shared/midi/unsupported-midi-input.js';
import type {
  AuditionVoice,
  FileExporter,
  PlaybackEngine,
  PlaybackObserver,
  PlaybackPlan,
  PlaybackTrack,
} from '@sudobility/music_types';
import { ToneJsMidiCodec } from '../shared/midi/codec.tonejs.js';
import { SharedTrackerCodec } from '../shared/mod/codec.js';
import { createMockAudioCodec } from './audio-codec.js';
import { MockXmlParser } from './xml.mock.js';
import type { MusicIo } from '../shared/types.js';

/** Records what it was asked to do and does nothing. */
export class MockPlaybackEngine implements PlaybackEngine {
  readonly calls: string[] = [];
  observer: PlaybackObserver | null = null;
  /** The plan the engine was last handed, for tests to assert on. */
  loadedPlan: PlaybackPlan | null = null;

  private record(name: string): void {
    this.calls.push(name);
  }

  async initialize(): Promise<void> {
    this.record('initialize');
  }

  async load(plan: PlaybackPlan): Promise<void> {
    this.loadedPlan = plan;
    this.record('load');
  }

  async play(fromTick?: number): Promise<void> {
    this.record(fromTick === undefined ? 'play' : `play(${fromTick})`);
  }

  pause(): void {
    this.record('pause');
  }

  stop(): void {
    this.record('stop');
  }

  seek(tick: number): void {
    this.record(`seek(${tick})`);
  }

  setTempoMultiplier(multiplier: number): void {
    this.record(`setTempoMultiplier(${multiplier})`);
  }

  setLoop(): void {
    this.record('setLoop');
  }

  setTrackMute(trackId: string, muted: boolean): void {
    this.record(`setTrackMute(${trackId},${muted})`);
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    this.record(`setTrackSolo(${trackId},${solo})`);
  }

  applyMix(tracks: readonly PlaybackTrack[]): void {
    this.record(`applyMix(${tracks.length})`);
  }

  setMetronome(enabled: boolean): void {
    this.record(`setMetronome(${enabled})`);
  }

  setMasterVolume(volume: number): void {
    this.record(`setMasterVolume(${volume})`);
  }

  noteOn(midi: number, voice: AuditionVoice): void {
    this.record(`noteOn(${midi},${voice.program})`);
  }

  noteOff(midi: number): void {
    this.record(`noteOff(${midi})`);
  }

  setObserver(observer: PlaybackObserver | null): void {
    this.observer = observer;
    this.record('setObserver');
  }

  dispose(): void {
    this.record('dispose');
  }
}

/** Records saves instead of touching a filesystem or a download. */
export class MockFileExporter implements FileExporter {
  readonly saved: Array<{ name: string; mimeType: string; data: Uint8Array | string }> = [];

  async save(name: string, data: Uint8Array | string, mimeType: string): Promise<void> {
    this.saved.push({ name, data, mimeType });
  }
}

export { MockXmlParser };
/**
 * A hand-built ProTracker module, for downstream tests.
 *
 * Exported from `/mocks` — the test-facing entry — so the app's e2e can build
 * a real module to import without a second builder that could drift from the
 * reader this package ships.
 */
export { buildMod } from '../shared/mod/fixture.js';
export type { MusicIo };

export function createMusicIo(): MusicIo {
  return {
    playback: new MockPlaybackEngine(),
    xmlParser: new MockXmlParser(),
    // The real codec: MIDI encoding is pure byte manipulation, so faking it
    // would only weaken the tests that use it.
    midiCodec: new ToneJsMidiCodec(),
    modCodec: new SharedTrackerCodec(),
    audioCodec: createMockAudioCodec(),
    audioRenderer: {
      // No audio context here; rendering is a browser capability.
      render: () => Promise.reject(new Error('Offline audio rendering is not available on this platform')),
    },
    midiInput: createUnsupportedMidiInput(),
    fileExporter: new MockFileExporter(),
  };
}
