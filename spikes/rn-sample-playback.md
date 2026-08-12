# Spike: how does React Native play a soundfont?

Run 2026-08-11, after `rn/index.ts` had shipped a `PlaybackEngine` that refused
outright. This supersedes `tone-on-rn-audio-api.md`, whose plan (subclass the
Tone engine, swap the audio context) was overtaken when the web engine moved off
Tone.js onto libfluidsynth.

## The blocker, established

The web engine is `js-synthesizer` — libfluidsynth compiled to WebAssembly —
running inside an `AudioWorklet`. Reading the shipped type surface of
`react-native-audio-api@0.13.2`:

```
npm pack react-native-audio-api@0.13.2
grep -rn "addModule|AudioWorkletNode|WebAssembly" package/lib/typescript
```

No `addModule`, no `AudioWorkletNode`, no WebAssembly. There *are*
`createWorkletNode` / `createWorkletProcessingNode` / `createWorkletSourceNode`,
but those run JavaScript on the audio thread via react-native-worklets — not an
`AudioWorkletGlobalScope` that can load an emscripten module. Hermes has no
WebAssembly engine either.

**So the web engine cannot be ported. It can only be replaced.** That part is a
platform limit, not an effort question.

## What React Native does have

Everything a sampler needs, which is the finding that mattered:

| Primitive | Present |
| --- | --- |
| `createBuffer` + `copyToChannel` | yes |
| `decodeAudioData` (native — AVFoundation / MediaCodec) | yes, 0.13+ |
| `AudioBufferSourceNode` with `playbackRate` **and** `detune` as `AudioParam`s | yes |
| `loop` / `loopStart` / `loopEnd` | yes |
| `AudioParam`: `setValueAtTime`, `linearRampToValueAtTime`, `setTargetAtTime`, `cancelAndHoldAtTime` | yes |
| `GainNode`, `BiquadFilterNode`, `StereoPannerNode`, `ConvolverNode` | yes |
| `OfflineAudioContext` | yes |

## The font, which is the whole point

Benjamin Gleitzman's `midi-js-soundfonts` publishes **FluidR3_GM** pre-rendered
per note, generated from `FluidR3_GM.sf2` — the same font the web engine plays
as `FluidR3Mono_GM.sf3`. Measured against the real files, not the README:

```
violin-mp3.js                 2.7 MB
samples in it                 88   (every key, MIDI 21..108)
worst detune across range     0 cents
format   MIDI.Soundfont.violin = { "A0": "data:audio/mp3;base64,…", … }
licence  CC-BY 3.0
```

Every key is a real recording, so in the normal range nothing is pitch-shifted
at all. `detune` exists in the engine for packs with gaps, and is normally 0.

The pack names are *not* the slug of the GM instrument name. Punctuation is
removed rather than turned into a separator — `Honky-tonk Piano` is
`honkytonk_piano`, and `Lead 8 (bass + lead)` keeps a double underscore where
the `+` was. That rule covers 127 of 128 programs; program 54 is a genuine
naming disagreement (GM's "Voice Oohs" vs. the catalogue's "Synth Voice").
`gm-pack-name.test.ts` pins all 128 against a vendored copy of the CDN manifest.

## What was built

`rn/playback/sample-engine.ts`, plus pure helpers with their own tests:
`sample-pack.ts` (parse, nearest-sample, detune), `gm-pack-name.ts`,
`voice-plan.ts` (gain and release scheduling), `audio-api.ts` (the narrow
structural slice of the library).

The transport half is **not** reimplemented: `flattenScoreForPlayback`,
`NoteQueue`, `planDispatch`, `headroomTrimFor` and `normalizeVelocity` moved
from `web/playback/` to `shared/playback/` and both engines now run the same
code. `governor.ts` and `channel-allocator.ts` stayed behind — they are
import-free but semantically fluidsynth-specific (interpolation orders, 16
channels per synth instance) — and `soundfont-loader.ts` stayed because it uses
the browser `caches` global.

## What this does and does not prove

`sample-engine.test.ts` drives the engine against a fake audio graph and covers
what the engine can get wrong on its own: dispatch ordering and lookahead, the
mute/solo gate, active-note reporting, position reporting, pack de-duplication
across plays and across a play/audition race, the load-state sequence, metronome
scheduling, drum-kit routing and exact-slot selection, and teardown. Each was confirmed by sabotage —
two of the tests passed against a deliberately broken engine on the first
attempt and were rewritten until they failed.

**It does not prove sound comes out of a speaker.** No test here can:
`react-native-audio-api` requires React Native at import time. That needs a
device, as it always will.

## Drums, which the packs do not have

The FluidR3, FatBoy and MusyngKite collections all publish the 128 melodic
programs and no percussion. The only pre-rendered GM percussion found is
WebAudioFont's, which is **GPL-3.0** and therefore unusable here.

So they are rendered instead, by `scripts/build-percussion-packs.mjs`, out of
the same `FluidR3Mono_GM.sf3` the web engine plays — FluidR3 is CC-BY 3.0, so
redistribution with attribution is allowed. One `fluidsynth` render per kit
(not per note: the font takes seconds to load, and 8 invocations beats 376),
sliced per drum, tails trimmed at -58dBFS, encoded mono 128kbps by `lame`:

```
Standard Kit     percussion_0-mp3.js   47 drums, 1134 KB
Room Kit         percussion_8-mp3.js   47 drums, 1446 KB
Power Kit        percussion_16-mp3.js  47 drums, 1272 KB
Electronic Kit   percussion_24-mp3.js  47 drums, 1239 KB
TR-808 Kit       percussion_25-mp3.js  44 drums, 1088 KB
Jazz Kit         percussion_32-mp3.js  47 drums, 1294 KB
Brush Kit        percussion_40-mp3.js  47 drums, 1196 KB
Orchestra Kit    percussion_48-mp3.js  47 drums, 1664 KB
```

TR-808's 44 is correct: it genuinely leaves three GM slots undefined, and the
silence trim drops them rather than shipping three empty files.

Selection uses `exactSample`, never `nearestSample`. A note number in a kit
names an instrument rather than a pitch, so the nearest defined slot is a
different drum, not a detuned right one.

## Known gaps

- **Sample-switching velocity layers.** A preset that swaps to a *different*
  recording above some velocity cannot be reproduced, because the packs hold one
  recording per note. The audible part of velocity — level and brightness — is
  reproduced (see below); the layer swap is not.
- **LFOs.** Vibrato and tremolo are baked into each recording as they evolved
  over its 3.13 seconds, so they neither restart with the note nor continue past
  a loop point.
- **Nothing is verified on a device.** Everything above is verified against
  fakes. Sound coming out of a speaker is not, and cannot be from here.

## SF2 expression, mostly recovered

Written off at first as inherent to sampling. It is not: the audio was
pre-rendered but the *behaviour* is parameters, and those are measurable.

`scripts/measure-expression.mjs` renders all 128 programs at five velocities
through fluidsynth and measures what changes — velocity-to-level,
velocity-to-brightness, release time, and whether the instrument sustains while
held. 8.8KB of table, applied by `playback/expression.ts`.

Measured rather than read out of the soundfont, after the direct route failed:
parsing `initialFilterFc` from `pdta` (readable even in SF3) gave Grand Piano a
300Hz low-pass against a rendered spectrum reaching 4.6kHz, because FluidR3's
piano preset layers two instruments and the recording is their sum. No single
layer's generators describe a layered preset.

Findings worth keeping:

- The SF2 default velocity modulator reduces analytically to **(v/127)²**, and
  the measurements agree. The engine's linear curve was 12dB out at velocity 32.
- Only **57 of 128** instruments darken with velocity at all. Piano moves
  ~4989Hz to ~556Hz; violin and flute do not move.
- Measured release ranges 0.07s to 1.49s, median 0.56s, against one 80ms
  constant for everything.
- **79 of 128** hold their level while held, and only those may be looped.

## Offline render

Also built, in `rn/audio/offline-render.ts`. The engine could not be reused
directly — it schedules against a live clock and pumps 200ms at a time, so an
export would take as long as the piece — but `RenderPlan` is already resolved to
seconds with mute and solo applied, so the whole graph is built up front against
an `OfflineAudioContext` and rendered as fast as the device manages. Sample
choice (`PackLibrary`) and gain/release (`planVoice`) are shared with the engine,
so the file is a recording of what was heard rather than a second voicing.

## The alternative, if this is not good enough on a device

A native FluidSynth module — `react-native-piano-sampler` does exactly this
(FluidSynth on Android, AudioKit/sfz on iOS), so the route is proven. It would
play the identical `.sf3` file the web plays, at the cost of Obj-C and Kotlin and
a device to verify. `PlaybackEngine` is what makes that a drop-in replacement
rather than a rewrite, which is the same reason the previous spike gave for not
building it up front.
