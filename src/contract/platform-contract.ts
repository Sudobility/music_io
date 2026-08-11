import { describe, expect, it } from 'vitest';
import type { MusicIo } from '../shared/types.js';
// The package's own hand-built module, so this cannot drift from the reader.
import { buildMod } from '../shared/mod/fixture.js';

/**
 * The one suite every platform implementation is held to.
 *
 * Without it, web, React Native and the mocks would each be tested differently
 * and could drift apart while all three stayed green — which is exactly the
 * failure a platform abstraction is supposed to prevent.
 */
export function runPlatformContract(name: string, createIo: () => MusicIo): void {
  describe(`${name}: platform contract`, () => {
    it('provides every service', () => {
      const io = createIo();
      expect(io.playback).toBeDefined();
      expect(io.xmlParser).toBeDefined();
      expect(io.midiCodec).toBeDefined();
      expect(io.fileExporter).toBeDefined();
      expect(io.audioCodec).toBeDefined();
      expect(io.modCodec).toBeDefined();
      expect(io.audioRenderer).toBeDefined();
      expect(io.audioTranscriber).toBeDefined();
    });

    it('answers a transcription request one way or the other', async () => {
      // Every platform has to have an answer: the web model, or a refusal a
      // caller can fall back from. Silence would look like a hung import.
      const io = createIo();
      const audio = { samples: new Float32Array(1024), sampleRate: 22050 };
      await expect(io.audioTranscriber.transcribe(audio)).rejects.toBeDefined();
    });

    it('rejects bytes that are not a module', () => {
      // A garbage score is worse than a clear failure: it looks like the file
      // imported and quietly is not the music.
      expect(() => createIo().modCodec.decode(new ArrayBuffer(64))).toThrow();
    });

    it('decodes a module to its patterns and order, leaving pitch to music_lib', () => {
      const io = createIo();
      const file = io.modCodec.decode(buildMod({}));
      expect(file.channels).toBe(4);
      expect(file.order).toEqual([0]);
      expect(file.patterns).toHaveLength(1);
      expect(file.patterns[0]).toHaveLength(64);
    });

    it('parses XML and exposes the root element', () => {
      const root = createIo().xmlParser.parse(
        '<score-partwise version="4.0"><part id="P1"/></score-partwise>',
      );
      expect(root.tagName).toBe('score-partwise');
      expect(root.getAttribute('version')).toBe('4.0');
      expect(Array.from(root.children)[0].tagName).toBe('part');
    });

    it('rejects malformed XML rather than returning a broken root', () => {
      expect(() => createIo().xmlParser.parse('<a><b></a>')).toThrow();
    });

    it('round-trips MIDI through the codec', () => {
      const io = createIo();
      const encoded = io.midiCodec.encode({
        header: {
          ppq: 480,
          tempos: [{ ticks: 0, bpm: 120 }],
          timeSignatures: [{ ticks: 0, timeSignature: [4, 4] }],
        },
        tracks: [
          {
            name: 'T',
            channel: 0,
            instrument: { number: 0 },
            notes: [{ midi: 60, ticks: 0, durationTicks: 480, velocity: 0.8 }],
            controlChanges: {},
            durationTicks: 480,
            durationSeconds: 0.5,
          },
        ],
        duration: 0.5,
      });
      expect(io.midiCodec.decode(encoded.buffer as ArrayBuffer).tracks[0].notes[0].midi).toBe(60);
    });

    it('implements the whole PlaybackEngine interface', () => {
      // A partially-implemented engine fails at the moment a user presses play,
      // which is the worst possible time to find out.
      const engine = createIo().playback as unknown as Record<string, unknown>;
      for (const method of [
        'initialize',
        'loadScore',
        'play',
        'pause',
        'stop',
        'seek',
        'setTempoMultiplier',
        'setLoop',
        'setTrackMute',
        'setTrackSolo',
        'setMetronome',
        'setMasterVolume',
        'noteOn',
        'noteOff',
        'setObserver',
        'dispose',
      ]) {
        expect(typeof engine[method], method).toBe('function');
      }
    });
    it('writes a real WAV file, not a bare buffer', () => {
      const io = createIo();
      const sampleRate = 44100;
      const samples = new Float32Array(sampleRate / 10);
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
      }

      const wav = io.audioCodec.encodeWav({ samples, sampleRate });
      expect(new TextDecoder().decode(new Uint8Array(wav, 0, 4))).toBe('RIFF');
      expect(new TextDecoder().decode(new Uint8Array(wav, 8, 4))).toBe('WAVE');
      expect(wav.byteLength).toBe(44 + samples.length * 2);
    });

  });
}
