/**
 * Test doubles for every platform service.
 *
 * Shipped from the package rather than duplicated in each consumer, so
 * music_lib's and music_app's tests exercise the same fakes this package's own
 * contract suite does.
 */
import type { FileExporter, PlaybackEngine, PlaybackObserver, Score } from '@sudobility/music_types';
import { ToneJsMidiCodec } from '../shared/midi/codec.tonejs.js';
import { createMockAudioCodec } from './audio-codec.js';
import { MockXmlParser } from './xml.mock.js';
import type { MusicIo } from '../shared/types.js';

/** Records what it was asked to do and does nothing. */
export class MockPlaybackEngine implements PlaybackEngine {
  readonly calls: string[] = [];
  observer: PlaybackObserver | null = null;
  loadedScore: Score | null = null;

  private record(name: string): void {
    this.calls.push(name);
  }

  async initialize(): Promise<void> {
    this.record('initialize');
  }

  async loadScore(score: Score): Promise<void> {
    this.loadedScore = score;
    this.record('loadScore');
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

  setMetronome(enabled: boolean): void {
    this.record(`setMetronome(${enabled})`);
  }

  setMasterVolume(volume: number): void {
    this.record(`setMasterVolume(${volume})`);
  }

  noteOn(midi: number, program: number): void {
    this.record(`noteOn(${midi},${program})`);
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
export type { MusicIo };

export function createMusicIo(): MusicIo {
  return {
    playback: new MockPlaybackEngine(),
    xmlParser: new MockXmlParser(),
    // The real codec: MIDI encoding is pure byte manipulation, so faking it
    // would only weaken the tests that use it.
    midiCodec: new ToneJsMidiCodec(),
    audioCodec: createMockAudioCodec(),
    audioRenderer: {
      // No audio context here; rendering is a browser capability.
      render: () => Promise.reject(new Error('Offline audio rendering is not available on this platform')),
    },
    fileExporter: new MockFileExporter(),
  };
}
