# Soundfont playback engine

Design, 2026-08-09. Replaces the Tone.js synthesis engine in `music_io` with a
WASM soundfont synth running on the audio thread.

## Why

Playback has failed repeatedly, and every failure has had the same shape: a
voice refused a note, or main-thread work arrived too late for the audio clock.

- A bare `MembraneSynth` threw on overlapping notes, silently losing them.
- The retrigger guard added to fix that drifted ahead of the clock and muted
  whole tracks partway through dense passages.
- Voice levels varied by 24 dB across families until they were measured and
  calibrated by hand.
- Velocity layers, added for expression, doubled the synthesis cost.

Each fix was correct and each was verified, but the pattern is the problem:
twenty-four hand-tuned synth patches, hand-calibrated levels, and hand-written
voice management, all scheduled from the main thread, is a large surface for a
result that still only approximates a General MIDI instrument set.

Sampled playback is a different cost class — a buffer read and a gain, against
one to two oscillators plus filters and envelopes per voice — and a mature synth
engine already solves voice allocation, stealing, and the GM percussion map.
Moving synthesis to the audio thread removes main-thread jitter from the timing
path entirely.

## Goals

1. Playback does not break on ordinary hardware with complex multitrack scores.
2. The synth never refuses a note. Exceeding polyphony steals a voice; nothing
   throws. The one case a note does not sound is deliberate and stated in the
   pump's late-note rule below: a note whose moment has already passed is
   skipped rather than fired late.
3. Timing is independent of main-thread load.
4. Quality degrades under load before playback does, timbre first and notes
   last.
5. Exported audio matches playback by construction, not by keeping two code
   paths in agreement.

## Non-goals

- Web MIDI output to external devices. A plausible future feature; not this.
- React Native playback. See "Retiring Tone.js is safe" below.
- Per-instrument sound design. The soundfont is the instrument set.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Engine | libfluidsynth-WASM (`js-synthesizer`) in an `AudioWorklet` | Synthesis on the audio thread; proven voice allocation and stealing |
| Tone.js | Retired entirely | No consumer survives it — see below |
| Asset | SF3 (Vorbis-compressed) GM soundfont, swappable via config | Quality tier at roughly a tenth of the bytes |
| First load | Blocks playback, with progress | Honest; no second engine to maintain |
| Channels | N synth instances of 16 channels each | Scores exceed 16 tracks; simpler than multiplexing |
| Degradation | Interpolation order, then polyphony cap | Maps exactly onto timbre-first, notes-last |

### Retiring Tone.js is safe

`@tonejs/midi` is a different package and stays: MIDI import and export are
unaffected.

The React Native path (`src/rn/playback/playback.rn.ts`) extends the Tone engine
and has never been verified — `spikes/tone-on-rn-audio-api.md` records that it
could not even be imported in a JS-only probe. `react-native-audio-api` is an
optional peer dependency, and no React Native application consumes this package.
Retiring it removes an unverified engine for a platform with no app, not a
working capability.

Only two Tone consumers need replacing rather than deleting:

- `src/web/audio/render.ts` (offline export) — becomes a synth render.
- `src/web/playback/metronome.ts` — a bare `Tone.Synth` click; becomes a short
  generated buffer.

## Architecture

```
main thread                                   audio thread
───────────                                   ────────────
Score
  │ flattenScoreForPlayback (unchanged)
  ▼
NoteQueue ── cursor
  │
  │ pump every ~50ms: drain the next ~200ms
  ▼
ScheduledEvent[] ──── postMessage ──────────▶ SoundfontProcessor
  (sample-stamped MIDI)                         │  N × libfluidsynth
                                                │  (16 channels each)
Governor ◀──── voice count, xruns ──────────────┤
  │ interpolation order, polyphony cap          ▼
  └──────────── postMessage ─────────────▶  master gain ▶ limiter ▶ destination
```

`PlaybackEngine` (in `music_types`) is unchanged. `music_lib`'s controller and
all of `music_app` are untouched.

## Components

### NoteQueue

A time-ordered array of notes plus a cursor.

- `load(score)` — flatten (reusing the existing `flattenScoreForPlayback`, which
  already joins tied notes correctly) and sort by tick.
- `seek(tick)` — binary search, move the cursor. No rescheduling.
- `drain(fromSec, toSec)` — return notes starting in the window, advance cursor.

Replaces scheduling ~11,500 Transport events up front. Editing rebuilds the
array; seeking is a cursor move.

### Pump

A repeating timer on the main thread.

- Interval 50 ms, lookahead window 200 ms.
- Each tick: `drain` the window, convert to MIDI events, stamp each with the
  audio-context sample it takes effect on, post one batch.
- Because events are stamped and applied in the worklet, the pump may run up to
  ~150 ms late with nothing audible.
- **Late-note rule:** a note whose start has already passed by more than the
  window is skipped, not fired late. This is the single deliberate exception to
  "never dropped", and it prevents a post-stall backlog arriving as one burst.

Driven by `setInterval`, with a `Worker`-based timer as a follow-up if
background-tab throttling proves to matter.

### SoundfontProcessor (AudioWorklet)

Hosts `N` libfluidsynth instances. Each instance has 16 channels, of which
channel 9 is reserved for percussion — so one instance holds 15 pitched tracks
and 1 percussion track:

```
N = max(ceil(pitchedTracks / 15), ceil(percussionTracks / 1), 1)
```

- Receives batches of sample-stamped MIDI events and applies each at its sample
  offset within the render quantum.
- Reports back, at most once per 100 ms: active voice count, and whether any
  render quantum overran.
- Exposes `setInterpolation(order)` and `setPolyphony(limit)`.

Exceeding polyphony steals the oldest voice inside FluidSynth. Nothing throws.

### ChannelAllocator

Assigns each track an `(instance, channel)` pair at load.

- Percussion tracks (percussion clef) take channel 9 of the next instance with a
  free channel 9.
- Pitched tracks take any free non-9 channel.
- 15 pitched tracks per instance; a new instance is created as needed.

Pure logic, unit tested, behind a seam so the policy can change without touching
the queue or the app.

### Mixer

Per track: volume → CC7, pan → CC10, mute/solo → channel gain. Mute/solo
semantics are unchanged (if anything is soloed, only soloed tracks sound).

Master chain keeps its current shape and arithmetic: worklet output → gain →
limiter → destination, with the `1/sqrt(n)` headroom trim and −1 dBFS ceiling.
Summing many channels has the same arithmetic regardless of what generates them.

### Governor

Reads pump deadline misses and the processor's reported voice count and overruns.

Ladder, worst-last:

1. Interpolation 7th order → 4th → linear → none *(timbre)*
2. Polyphony cap stepped down *(notes — voices get stolen sooner)*

Steps back up when the measurements recover, with hysteresis so it cannot
oscillate. Never drops a note-on; a stolen voice cuts an older note short, which
is the agreed trade.

### SoundfontLoader

- Fetch the configured SF3 once; store via Cache API keyed by font version.
- Emit progress; `play` is disabled behind a "preparing instruments" state until
  ready.
- No `AudioWorklet` or no WASM → a clear, surfaced error. There is no fallback
  engine by design.

### Offline render

`renderOffline(plan)` drives the same synth offline, faster than realtime, and
returns the same `DecodedAudio`. Export is the same engine as playback by
construction, so the divergence fixed earlier cannot reappear.

## Error handling

| Failure | Behaviour |
| --- | --- |
| Soundfont fetch fails | Surfaced error; play stays disabled; retry offered |
| Worklet or WASM unavailable | Surfaced error naming the missing capability |
| Processor throws mid-render | Caught in the worklet, reported, that quantum silent; playback continues |
| Polyphony exceeded | Voice stolen inside FluidSynth; no error |
| Pump runs late | Events still land on time within the window; beyond it, late notes skipped |
| Score exceeds channel capacity | New synth instance allocated; no user-visible limit |

## Testing

Pure logic, unit tested as usual: `NoteQueue` (drain windows, seek, tie-joined
input), `ChannelAllocator` (percussion placement, overflow to new instances),
`Governor` (ladder order, hysteresis), and the pump's late-note rule with an
injected clock.

The synth itself cannot be unit tested — the same honest limit `renderOffline`
has today, and for the same reason: a test would only assert that a mock agrees
with itself. It is verified by offline render plus measurement, reusing the
calibration harness already in `tools/calibrate.html`, which is repointed at the
new engine to check per-program level and ring time.

Regression tests worth keeping from the current engine, restated against the new
one: a punctual stream of hits arrives unmoved; a dense pile-up on one voice
does not compound; every GM program produces sound; percussion resolves by clef.

## Migration

1. Add the worklet, processor, loader, queue, pump, allocator and governor
   alongside the existing engine. Nothing removed yet.
2. Switch `createMusicIo()` on web to the new engine.
3. Repoint `renderOffline` at the synth.
4. Replace the metronome click.
5. Delete `instruments/`, `mixer.ts`, `audition.ts`, `metronome.ts`,
   `tone-engine.ts`, `mix.ts` and `src/rn/playback/`; drop the `tone` and
   `react-native-audio-api` dependencies; and remove the `./rn` entry from the
   package's `exports` map along with its build output. Removing a public entry
   point is a breaking change for the package, so it takes a major version.
6. Re-verify with the calibration harness and the full suite.

Steps 1–2 are independently shippable behind a config flag; the deletions in
step 5 only happen once the new engine is verified.

## Risks

| Risk | Mitigation |
| --- | --- |
| First-run download is large even as SF3 | Cache API persistence; progress UI; font is swappable, so a smaller one is a config change |
| `js-synthesizer` proves unsuitable in an AudioWorklet | Spike it first, before any deletion — this is the one assumption the whole design rests on |
| Soundfont licensing | Choose a permissively licensed GM font before implementation; record the choice and its terms |
| Losing the "no bundled assets" property | Accepted deliberately: it is what buys the fidelity and the CPU headroom |
| Background-tab timer throttling stalls the pump | Worker-based timer if observed |

## First implementation task: choose the soundfont

Its size and licence are inputs to the loader and to this repo's distribution
terms, so it is settled before any code.

Requirements: a complete General MIDI set including a percussion bank, available
as SF3 or convertible to it, under a licence permitting redistribution in a
commercial product.

Candidates to evaluate, in order of expected fit — **each licence must be read
and recorded before adoption, not assumed**:

1. **MuseScore General** — already distributed as SF3, complete GM set, size in
   the tens of MB. The closest match to what this design asks for.
2. **GeneralUser GS** — complete GM set, long-standing permissive redistribution
   terms, would need SF3 conversion.
3. **FluidR3 GM** — complete and widely used, but large, and would need both
   licence confirmation and SF3 conversion.

The outcome to record: font name, version, licence and its terms, byte size as
shipped, and where it is hosted.
