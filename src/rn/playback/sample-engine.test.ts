import { beforeEach, describe, expect, it, vi } from 'vitest';
import { changeClefCommand, changeTrackPropsCommand, twoTrackScore } from '@sudobility/music_lib';
import type {
  SoundingNote, PlaybackLoadState, TransportPlaybackState } from '@sudobility/music_types';
import { RNSamplePlaybackEngine, base64ToBytes } from './sample-engine.js';
import type { AudioApi } from './audio-api.js';

/**
 * A fake audio graph.
 *
 * `react-native-audio-api` needs React Native at import time, so nothing here
 * can drive the real one — but everything the engine gets wrong on its own is
 * above that line: which notes are dispatched, when, at what gain, for which
 * tracks. This records the calls so those can be asserted.
 */
type StartedSource = { detune: number; startAt: number; stopAt: number | null; gainAt: number; cutoff: number | null; looped: boolean };

class FakeGraph {
  currentTime = 0;
  readonly sources: StartedSource[] = [];
  readonly oscillators: Array<{ hz: number; startAt: number }> = [];
  closed = false;

  readonly api: AudioApi;

  constructor() {
    // Captured explicitly rather than through `this`: the fake context reads a
    // clock the test moves between assertions, so the closure has to see the
    // live values, not a snapshot.
    /** The source most recently created, so a filter can attach to its record. */
    let building: StartedSource | null = null;
    const graph = {
      sources: this.sources,
      oscillators: this.oscillators,
      getTime: () => this.currentTime,
      close: () => {
        this.closed = true;
      },
    };
    const param = (onSet?: (v: number) => void) => ({
      value: 0,
      setValueAtTime(v: number) {
        onSet?.(v);
        return this;
      },
      linearRampToValueAtTime() {
        return this;
      },
      cancelScheduledValues() {
        return this;
      },
    });

    const ctx = {
      get currentTime() {
        return graph.getTime();
      },
      sampleRate: 44100,
      destination: { connect: () => undefined, disconnect: () => undefined },
      createGain() {
        let peak = 0;
        return {
          gain: param((v) => {
            if (peak === 0) peak = v;
          }),
          get _peak() {
            return peak;
          },
          connect: () => undefined,
          disconnect: () => undefined,
        };
      },
      createBufferSource() {
        const record: StartedSource = {
          detune: 0, startAt: -1, stopAt: null, gainAt: 0, cutoff: null, looped: false,
        };
        // The filter and the loop attach to whichever source was built last —
        // `buildVoiceFromPlan` always creates the source first.
        building = record;
        return {
          buffer: null,
          get loop() {
            return record.looped;
          },
          set loop(v: boolean) {
            record.looped = v;
          },
          loopStart: 0,
          loopEnd: 0,
          playbackRate: param(),
          detune: {
            ...param(),
            set value(v: number) {
              record.detune = v;
            },
            get value() {
              return record.detune;
            },
          },
          start(when = 0) {
            record.startAt = when;
            graph.sources.push(record);
          },
          stop(when?: number) {
            record.stopAt = when ?? graph.getTime();
          },
          connect: () => undefined,
          disconnect: () => undefined,
        };
      },
        createBiquadFilter() {
          const record = building;
          return {
            type: 'lowpass',
            frequency: {
              ...param(),
              set value(v: number) { if (record) record.cutoff = v; },
              get value() { return record?.cutoff ?? 0; },
            },
            Q: param(),
            connect: () => undefined,
            disconnect: () => undefined,
          };
        },
      createOscillator() {
        const rec = { hz: 0, startAt: 0 };
        return {
          type: 'sine',
          frequency: {
            ...param(),
            set value(v: number) {
              rec.hz = v;
            },
            get value() {
              return rec.hz;
            },
          },
          start(when = 0) {
            rec.startAt = when;
            graph.oscillators.push(rec);
          },
          stop: () => undefined,
          connect: () => undefined,
          disconnect: () => undefined,
        };
      },
      resume: async () => undefined,
      close: async () => {
        graph.close();
      },
    };

    this.api = {
      AudioContext: function () {
        return ctx;
      } as unknown as AudioApi['AudioContext'],
      decodeAudioData: async () => ({
        length: 1000,
        numberOfChannels: 1,
        sampleRate: 44100,
        duration: 1,
        getChannelData: () => new Float32Array(1000),
      }),
    };
  }
}

/** A pack body covering every key, like the real FluidR3 packs do. */
function packBody(instrument: string): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const entries: string[] = [];
  for (let midi = 21; midi <= 108; midi += 1) {
    entries.push(`"${names[midi % 12]}${Math.floor(midi / 12) - 1}": "data:audio/mp3;base64,AAAA"`);
  }
  return `MIDI.Soundfont.${instrument} = {${entries.join(',')}}`;
}

/**
 * A drum kit pack: GM's 35..81, minus slot 43.
 *
 * The gap is at 43 on purpose. `scoreWithDrums`'s drum part plays 36 and 43
 * (C2 and G2 from `twoTrackScore`'s bass line), so one of its two notes lands
 * on a slot this kit does not define — which is what makes the
 * never-bend-a-drum assertion able to fail. A gap at a note nothing plays
 * tests nothing; the first version of this fixture omitted 56 and the
 * assertion passed against an engine that bent every drum.
 */
function kitBody(name: string): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const entries: string[] = [];
  for (let midi = 35; midi <= 81; midi += 1) {
    if (midi === 43) continue;
    entries.push(`"${names[midi % 12]}${Math.floor(midi / 12) - 1}": "data:audio/mp3;base64,AAAA"`);
  }
  return `MIDI.Soundfont.${name} = {${entries.join(',')}}`;
}

function makeEngine(overrides: { fetchPack?: (url: string) => Promise<string>; percussionBase?: string } = {}) {
  const graph = new FakeGraph();
  const pumps: Array<() => void> = [];
  const engine = new RNSamplePlaybackEngine({
    loadAudioApi: async () => graph.api,
    percussionBase: overrides.percussionBase ?? 'https://app.example.com/audio/percussion/',
    fetchPack:
      overrides.fetchPack ??
      (async (url) => {
        const name = /\/([a-z0-9_]+)-mp3\.js$/.exec(url)![1]!;
        return name.startsWith('percussion_') ? kitBody(name) : packBody(name);
      }),
    startPump: (tick) => {
      pumps.push(tick);
      return () => {
        const i = pumps.indexOf(tick);
        if (i >= 0) pumps.splice(i, 1);
      };
    },
  });
  /** Runs every registered timer once — the pump and the position reporter. */
  const step = () => [...pumps].forEach((p) => p());
  return { engine, graph, step };
}

function recordingObserver() {
  const states: TransportPlaybackState[] = [];
  const loads: PlaybackLoadState[] = [];
  const activeNotes: SoundingNote[][] = [];
  const ticks: number[] = [];
  return {
    states,
    loads,
    activeNotes,
    ticks,
    observer: {
      onPositionTick: (t: number) => ticks.push(t),
      onActiveNotes: (notes: SoundingNote[]) => activeNotes.push(notes),
      onStateChange: (s: TransportPlaybackState) => states.push(s),
      onLoadStateChange: (s: PlaybackLoadState) => loads.push(s),
    },
  };
}

/** twoTrackScore with its second track turned into a TR-808 drum part. */
function scoreWithDrums() {
  let score = twoTrackScore();
  const drumTrack = score.tracks[1]!.id;
  score = changeClefCommand(drumTrack, 'percussion').execute(score);
  score = changeTrackPropsCommand(drumTrack, { midiProgram: 25 }).execute(score);
  return { score, drumTrack };
}

describe('RNSamplePlaybackEngine', () => {
  let ctx: ReturnType<typeof makeEngine>;

  beforeEach(() => {
    ctx = makeEngine();
  });

  it('does not report playing until the packs are decoded and a note could sound', async () => {
    // The same rule the web engine follows. The caret dead-reckons between
    // position reports, so announcing `playing` early glides it silently
    // through several bars and snaps it back when sound finally starts.
    const events: string[] = [];
    ctx.engine.setObserver({
      onPositionTick: () => undefined,
      onActiveNotes: () => undefined,
      onStateChange: (s) => events.push(`state:${s}`),
      onLoadStateChange: (s) => events.push(`load:${s.status}`),
    });
    await ctx.engine.loadScore(twoTrackScore());

    await ctx.engine.play();

    // Ordering is the assertion. A snapshot taken right after calling play()
    // proves nothing: play() awaits before it could set any state, so the
    // check passes wherever setState sits.
    expect(events).toContain('state:playing');
    expect(events.indexOf('state:playing')).toBeGreaterThan(events.lastIndexOf('load:loading'));
    expect(events.indexOf('state:playing')).toBeGreaterThan(events.indexOf('load:ready'));
  });

  it('schedules the score\'s notes as soon as playback starts', async () => {
    await ctx.engine.loadScore(twoTrackScore());
    await ctx.engine.play();

    expect(ctx.graph.sources.length).toBeGreaterThan(0);
    // Everything is scheduled ahead of the clock, never behind it.
    expect(ctx.graph.sources.every((s) => s.startAt >= ctx.graph.currentTime)).toBe(true);
    expect(ctx.graph.sources.every((s) => s.stopAt !== null && s.stopAt > s.startAt)).toBe(true);
  });

  it('keeps decoded packs across plays rather than refetching them', async () => {
    const fetched: string[] = [];
    const local = makeEngine({
      fetchPack: async (url) => {
        fetched.push(url);
        return packBody(/\/([a-z0-9_]+)-mp3\.js$/.exec(url)![1]!);
      },
    });
    await local.engine.loadScore(twoTrackScore());
    await local.engine.play();
    const afterFirst = fetched.length;
    local.engine.stop();

    await local.engine.play();

    // 2.7MB apiece. Refetching on every press of Play is the difference
    // between a usable app and not, on a phone connection.
    expect(afterFirst).toBeGreaterThan(0);
    expect(fetched).toHaveLength(afterFirst);
  });

  it('reports ready immediately on a replay, with no spurious loading phase', async () => {
    // The already-decoded guard in ensureScorePacks. Without it the in-flight
    // memo still prevents a refetch, so nothing is downloaded twice — but the
    // engine walks a 0..1 progress bar over work it is not doing, and the
    // transport shows "Preparing instruments" on every press of Play.
    const local = makeEngine();
    await local.engine.loadScore(twoTrackScore());
    await local.engine.play();
    local.engine.stop();

    const loads: PlaybackLoadState[] = [];
    local.engine.setObserver({
      onPositionTick: () => undefined,
      onActiveNotes: () => undefined,
      onStateChange: () => undefined,
      onLoadStateChange: (s) => loads.push(s),
    });
    loads.length = 0;
    await local.engine.play();

    expect(loads.map((l) => l.status)).not.toContain('loading');
  });

  it('fetches a pack once when a play and an audition race for it', async () => {
    const fetched: string[] = [];
    const local = makeEngine({
      fetchPack: async (url) => {
        fetched.push(url);
        await new Promise((r) => setTimeout(r, 5)); // long enough to overlap
        return packBody(/\/([a-z0-9_]+)-mp3\.js$/.exec(url)![1]!);
      },
    });
    await local.engine.loadScore(twoTrackScore());

    local.engine.noteOn(60, 0);
    await local.engine.play();
    await vi.waitFor(() => expect(local.graph.sources.length).toBeGreaterThan(0));

    // Both want the piano pack. Without the in-flight memo each starts its own
    // download of the same 2.7MB.
    expect(new Set(fetched).size).toBe(fetched.length);
  });

  it('plays nothing for a muted track', async () => {
    const score = twoTrackScore();
    await ctx.engine.loadScore(score);
    for (const track of score.tracks) ctx.engine.setTrackMute(track.id, true);
    await ctx.engine.play();
    ctx.step();

    expect(ctx.graph.sources).toHaveLength(0);
  });

  it('silences every unsoloed track when anything is soloed', async () => {
    const score = twoTrackScore();
    const solo = makeEngine();
    await solo.engine.loadScore(score);
    solo.engine.setTrackSolo(score.tracks[0]!.id, true);
    await solo.engine.play();
    solo.step();
    const soloedCount = solo.graph.sources.length;

    const all = makeEngine();
    await all.engine.loadScore(score);
    await all.engine.play();
    all.step();

    expect(soloedCount).toBeGreaterThan(0);
    expect(soloedCount).toBeLessThan(all.graph.sources.length);
  });

  it('reports the sounding note ids so the editor can highlight them', async () => {
    const { observer, activeNotes } = recordingObserver();
    ctx.engine.setObserver(observer);
    await ctx.engine.loadScore(twoTrackScore());
    await ctx.engine.play();
    ctx.step();

    expect(activeNotes.some((ids) => ids.length > 0)).toBe(true);
  });

  it('coalesces active-note updates within one pump pass', async () => {
    const { observer, activeNotes } = recordingObserver();
    ctx.engine.setObserver(observer);
    await ctx.engine.loadScore(twoTrackScore());

    await ctx.engine.play();

    // Two notes start on the downbeat, but the observer sees the pump's final
    // active-note set once instead of one store update per voice.
    expect(activeNotes).toHaveLength(1);
    expect(activeNotes[0]!.length).toBeGreaterThan(1);
  });

  it('reports position while playing', async () => {
    const { observer, ticks } = recordingObserver();
    ctx.engine.setObserver(observer);
    await ctx.engine.loadScore(twoTrackScore());
    await ctx.engine.play();
    ticks.length = 0;

    ctx.graph.currentTime = 1;
    ctx.step();

    expect(ticks.some((t) => t > 0)).toBe(true);
  });

  it('stops the pump and silences everything on pause', async () => {
    await ctx.engine.loadScore(twoTrackScore());
    await ctx.engine.play();
    ctx.step();
    const scheduled = ctx.graph.sources.length;

    ctx.engine.pause();
    ctx.step();

    expect(ctx.graph.sources).toHaveLength(scheduled); // nothing new dispatched
  });

  it('reports the current tick before pausing so the caret does not jump to the last sample', async () => {
    const { observer, ticks } = recordingObserver();
    ctx.engine.setObserver(observer);
    await ctx.engine.loadScore(twoTrackScore());
    await ctx.engine.play();
    ticks.length = 0;

    ctx.graph.currentTime = 1;
    ctx.engine.pause();

    expect(ticks.at(-1)).toBeGreaterThan(0);
  });

  it('schedules metronome clicks only when the metronome is on', async () => {
    await ctx.engine.loadScore(twoTrackScore());
    await ctx.engine.play();
    ctx.step();
    expect(ctx.graph.oscillators).toHaveLength(0);

    const withClick = makeEngine();
    await withClick.engine.loadScore(twoTrackScore());
    withClick.engine.setMetronome(true);
    await withClick.engine.play();
    withClick.step();

    expect(withClick.graph.oscillators.length).toBeGreaterThan(0);
    // Beat 1 is accented, and an accent is the higher pitch.
    expect(withClick.graph.oscillators[0]!.hz).toBe(1600);
  });

  it('auditions a key without touching transport state', async () => {
    const { observer, states, ticks } = recordingObserver();
    ctx.engine.setObserver(observer);
    await ctx.engine.loadScore(twoTrackScore());
    states.length = 0;
    ticks.length = 0;

    ctx.engine.noteOn(60, 0);
    await vi.waitFor(() => expect(ctx.graph.sources.length).toBeGreaterThan(0));

    expect(states).toEqual([]);
    expect(ticks).toEqual([]);
  });

  it('surfaces a failed pack fetch as a failed load state', async () => {
    const failing = makeEngine({ fetchPack: async () => '<!doctype html><title>404</title>' });
    const { observer, loads } = recordingObserver();
    failing.engine.setObserver(observer);
    await failing.engine.loadScore(twoTrackScore());

    await expect(failing.engine.play()).rejects.toThrow(/not a MIDI\.js sample pack/i);
    expect(loads[loads.length - 1]).toMatchObject({ status: 'failed' });
  });

  it('closes the audio context on dispose', async () => {
    await ctx.engine.loadScore(twoTrackScore());
    await ctx.engine.play();
    ctx.engine.dispose();

    expect(ctx.graph.closed).toBe(true);
  });
});

describe('RNSamplePlaybackEngine expression', () => {
  it('darkens a soft note on an instrument whose timbre tracks velocity', async () => {
    // twoTrackScore is piano (program 0), which measured a steep velocity
    // response: ~5kHz at v96 down to ~556Hz at v16. Without the filter every
    // dynamic sounds like the same recording at a different volume.
    const local = makeEngine();
    const score = twoTrackScore();
    await local.engine.loadScore(score);
    await local.engine.play();
    local.step();

    const filtered = local.graph.sources.filter((s) => s.cutoff !== null);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((s) => s.cutoff! > 0 && s.cutoff! < 16000)).toBe(true);
  });

  it('holds a note longer than the 3.13s recording by looping its sustain', async () => {
    // The truncation bug: every pack entry is 3.13s, so a long note simply
    // stopped sounding partway through with the envelope holding over nothing.
    const local = makeEngine();
    let score = twoTrackScore();
    // Strings, because only a sustaining instrument may be looped — piano and
    // acoustic bass are both already decaying and must never be.
    score = changeTrackPropsCommand(score.tracks[1]!.id, { midiProgram: 48 }).execute(score);
    // The bass part is whole notes; slow the tempo so one outlasts a sample.
    await local.engine.loadScore({ ...score, tempoMap: [{ id: 'slow', tick: 0, bpm: 30 }] });
    await local.engine.play();
    for (let t = 0; t <= 4; t += 0.5) {
      local.graph.currentTime = t;
      local.step();
    }

    expect(local.graph.sources.some((s) => s.looped)).toBe(true);
  });

  it('never loops a drum, whose decay is already the recording', async () => {
    const local = makeEngine();
    const { score } = scoreWithDrums();
    await local.engine.loadScore({ ...score, tempoMap: [{ id: 'slow', tick: 0, bpm: 30 }] });
    await local.engine.play();
    for (let t = 0; t <= 4; t += 0.5) {
      local.graph.currentTime = t;
      local.step();
    }

    expect(local.graph.sources.every((s) => !s.looped || s.cutoff === null)).toBe(true);
  });
});

describe('RNSamplePlaybackEngine percussion', () => {
  it('loads the drum kit pack for a percussion track, not an instrument pack', async () => {
    const fetched: string[] = [];
    const local = makeEngine({
      fetchPack: async (url) => {
        fetched.push(url);
        const name = /\/([a-z0-9_]+)-mp3\.js$/.exec(url)![1]!;
        return name.startsWith('percussion_') ? kitBody(name) : packBody(name);
      },
    });
    const { score } = scoreWithDrums();
    await local.engine.loadScore(score);
    await local.engine.play();

    // Program 25 is the TR-808 kit AND, on a pitched track, a Violin. Reading
    // it as an instrument is the bug this asserts against.
    expect(fetched.some((u) => u.includes('percussion_25-mp3.js'))).toBe(true);
    expect(fetched.some((u) => u.includes('violin'))).toBe(false);
  });

  it('serves drum kits from the app-hosted base, not the melodic CDN', async () => {
    const fetched: string[] = [];
    const local = makeEngine({
      percussionBase: 'https://app.example.com/audio/percussion/',
      fetchPack: async (url) => {
        fetched.push(url);
        const name = /\/([a-z0-9_]+)-mp3\.js$/.exec(url)![1]!;
        return name.startsWith('percussion_') ? kitBody(name) : packBody(name);
      },
    });
    const { score } = scoreWithDrums();
    await local.engine.loadScore(score);
    await local.engine.play();

    const kitUrl = fetched.find((u) => u.includes('percussion_25'))!;
    expect(kitUrl).toBe('https://app.example.com/audio/percussion/percussion_25-mp3.js');
  });

  it('sounds drums, and leaves an undefined slot silent rather than bending to it', async () => {
    const local = makeEngine();
    const { score } = scoreWithDrums();
    await local.engine.loadScore(score);
    await local.engine.play();

    // Walk the clock past measure 2. The lookahead is 0.2s, so a single pump
    // at t=0 only ever reaches the downbeat — and the drum part's note on the
    // *missing* slot is in measure 2, four beats in. Without advancing, this
    // assertion passes against an engine that bends every drum it plays.
    for (let t = 0; t <= 5; t += 0.5) {
      local.graph.currentTime = t;
      local.step();
    }

    expect(local.graph.sources.length).toBeGreaterThan(0);
    // A drum note number names an *instrument*, not a pitch, so the nearest
    // slot is not a worse version of the right answer — it is a different
    // drum. Every source that started must be unbent.
    expect(local.graph.sources.every((s) => s.detune === 0)).toBe(true);
  });

  it('auditions a drum from the kit rather than the GM instrument table', async () => {
    const fetched: string[] = [];
    const local = makeEngine({
      fetchPack: async (url) => {
        fetched.push(url);
        const name = /\/([a-z0-9_]+)-mp3\.js$/.exec(url)![1]!;
        return name.startsWith('percussion_') ? kitBody(name) : packBody(name);
      },
    });
    await local.engine.loadScore(twoTrackScore());

    local.engine.noteOn(38, 25, true); // snare, on the TR-808 kit
    await vi.waitFor(() => expect(local.graph.sources.length).toBeGreaterThan(0));

    expect(fetched.some((u) => u.includes('percussion_25-mp3.js'))).toBe(true);
    expect(local.graph.sources[0]!.detune).toBe(0);
  });

  it('says what is wrong when percussion is used with no host configured', async () => {
    const local = makeEngine({ percussionBase: undefined });
    // Deliberately cleared: an app that ships scores with drums and never hosts
    // the kits should get a sentence naming the build script, not silence.
    const bare = new RNSamplePlaybackEngine({
      loadAudioApi: async () => local.graph.api,
      fetchPack: async () => kitBody('percussion_25'),
      startPump: () => () => undefined,
    });
    const { score } = scoreWithDrums();
    await bare.loadScore(score);

    await expect(bare.play()).rejects.toThrow(/percussionBase/);
  });
});

describe('base64ToBytes', () => {
  it('decodes without atob or Buffer, neither of which Hermes reliably has', () => {
    // "Hello" -> SGVsbG8=
    expect(Array.from(new Uint8Array(base64ToBytes('SGVsbG8=')))).toEqual([72, 101, 108, 108, 111]);
  });

  it('matches Buffer across a byte range, so mp3 frames survive intact', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const base64 = Buffer.from(bytes).toString('base64');
    expect(Array.from(new Uint8Array(base64ToBytes(base64)))).toEqual(Array.from(bytes));
  });
});
