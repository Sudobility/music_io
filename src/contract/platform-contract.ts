import { describe, expect, it } from 'vitest';
import type { MusicIo } from '../shared/types.js';
// The package's own hand-built module, so this cannot drift from the reader.
import { buildMod } from '../shared/mod/fixture.js';

/**
 * What a platform promises about the two capabilities that are not universal.
 *
 * Stated per entry rather than inferred, because "this platform cannot do
 * audio" is a design decision and should read like one at the call site. Every
 * other service — XML, MIDI, MOD, WAV, file export — is required of everyone
 * and needs no flag.
 */
export type PlatformCapabilities = {
  /**
   * `'accepts'` — a real engine, or a recording double. `'refuses'` — the
   * sound-producing methods throw and the lifecycle methods are silent no-ops.
   */
  playback: 'accepts' | 'refuses';
  /** `'renders'` — real offline render. `'refuses'` — `render()` rejects. */
  offlineRender: 'renders' | 'refuses';
};

/** Sound comes out of these, so a platform that cannot must say so loudly. */
const SOUND_PRODUCING = ['initialize', 'loadScore', 'play', 'noteOn'] as const;

/**
 * These must stay silent even on a platform with no audio: a shared component
 * calling `pause()` on unmount, or `dispose()` in a cleanup, must not crash an
 * app that simply has no playback.
 */
const LIFECYCLE = [
  'pause',
  'stop',
  'seek',
  'setTempoMultiplier',
  'setLoop',
  'setTrackMute',
  'setTrackSolo',
  'setMetronome',
  'setMasterVolume',
  'noteOff',
  'setObserver',
  'dispose',
] as const;

/**
 * The one suite every platform implementation is held to.
 *
 * Without it, web, React Native and the mocks would each be tested differently
 * and could drift apart while all three stayed green — which is exactly the
 * failure a platform abstraction is supposed to prevent.
 */
export function runPlatformContract(
  name: string,
  createIo: () => MusicIo,
  capabilities: PlatformCapabilities,
): void {
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

    it('exposes every PlaybackEngine method', () => {
      // A partially-implemented engine fails at the moment a user presses play,
      // which is the worst possible time to find out. Shape only — what these
      // methods *do* is the next two tests, because it differs by platform.
      const engine = createIo().playback as unknown as Record<string, unknown>;
      for (const method of [...SOUND_PRODUCING, ...LIFECYCLE]) {
        expect(typeof engine[method], method).toBe('function');
      }
    });

    if (capabilities.playback === 'refuses') {
      /**
       * The half of "refuses rather than pretends" that a shape check cannot
       * see. Sixteen `typeof === 'function'` assertions pass just as happily
       * against an engine of silent no-ops, which is the failure this exists to
       * catch: a user presses play, nothing happens, and nothing says why.
       */
      it('throws from every method that would make a sound', () => {
        const engine = createIo().playback as unknown as Record<string, () => unknown>;
        for (const method of SOUND_PRODUCING) {
          expect(() => engine[method]!(), method).toThrow();
        }
      });

      it('stays silent for every lifecycle method, so unmount cleanup cannot crash the app', () => {
        const engine = createIo().playback as unknown as Record<string, () => unknown>;
        for (const method of LIFECYCLE) {
          expect(() => engine[method]!(), method).not.toThrow();
        }
      });
    }

    if (capabilities.offlineRender === 'refuses') {
      it('rejects an offline render rather than resolving with silence', async () => {
        // Resolving empty audio here would surface as a mysteriously silent
        // export, not as an unsupported feature.
        await expect(createIo().audioRenderer.render({} as never)).rejects.toThrow();
      });
    }
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
