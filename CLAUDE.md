# music_io

Platform implementations for ScoreSmith: playback, XML parsing, file export and
the MIDI codec, for web and React Native. One of six repos in the family — see
`music_app/docs/architecture.md`.

The contracts live in `@sudobility/music_types`; this package implements them so
`@sudobility/music_lib` can stay free of any platform library and run unchanged
on both platforms.

## Tech Stack

- TypeScript (strict, ESM only), Bun, **Vitest** (not `bun test`)
- `js-synthesizer` (libfluidsynth in an AudioWorklet — the web engine),
  `@tonejs/midi` (SMF codec), `fast-xml-parser` (RN XML), `react-native-fs` /
  `react-native-share` (RN file export) — **all optional peer dependencies**.
  `@breezystack/lamejs` is the one runtime dependency; see Gotchas. `tone` is
  gone: the web engine is the soundfont synth, and RN has no engine at all.

## Commands

- `bun run verify` — typecheck + lint + test + build. Run before any push.
- `bun run test` — Vitest

## Structure

- `src/web/` — `SoundfontPlaybackEngine` and its scheduling/mixing modules (~1,500 lines, the bulk of this package), the offline soundfont renderer, `WebXmlParser`, `WebFileExporter`
- `src/rn/` — `RNXmlParser`, `RNFileExporter`, a full audio codec (OS decoder via `react-native-audio-api`, shared encoders), and `playback/` — `RNSamplePlaybackEngine`, a sample-based FluidR3 engine
- `src/shared/` — the `MusicIo` bundle type, `ToneJsMidiCodec`, `SharedModCodec`, the wav/mp3 encoders and mono mixdown, and `playback/` (score flattening, note cursor, dispatch window, master trim, MIDI maths) — the transport half both engines run. Everything here is pure logic over bytes and numbers, which is the test for belonging in it
- `src/mocks/` — test doubles, including a small hand-rolled XML reader
- `src/contract/` — `runPlatformContract`, the suite every entry is held to

## Gotchas

- **Platform *engines* are optional peers; `@breezystack/lamejs` is the one
  exception.** A React Native app must never pull a browser audio library into
  its graph, which is why `js-synthesizer` — libfluidsynth compiled to WASM, for
  an AudioWorklet — is an optional peer that music_app declares itself. lamejs
  stays a runtime `dependency` for two concrete reasons: `web-audio-codec.ts`
  imports it *statically*, so an app that skipped installing it would fail to
  load the entire web entry rather than just mp3 export; and `AudioCodec.encodeMp3`
  is synchronous in `music_types`, so it cannot be made lazy the way
  `js-synthesizer` is without changing that interface across four repos. It is
  pure JS and runs under Metro — and now that `encodeMp3` is shared, the RN
  entry imports it too, which settles the question: it is not a platform
  library at all.
- **The export map is the whole mechanism.** `"react-native"` resolves to
  `dist/rn`, `"default"` to `dist/web`, so app code writes one import and never
  branches on platform. `./web`, `./rn` and `./mocks` stay addressable for tests.
- **Optional peers must also be devDependencies.** CI does a clean install; a
  library that only exists in a developer's `node_modules` from an ad-hoc
  `bun add` will typecheck locally and fail in CI. That happened.
- **`music_lib` is a peer dependency, and the direction matters.** The engine
  needs domain knowledge (scheduling a score, GM instrument lookup) that belongs
  in music_lib, so it is imported rather than copied. music_lib imports this
  package *only in its tests*, which is what keeps it one-way. Do not add a
  music_io import to music_lib's `src` — that would make the dependency
  bidirectional. It is also why music_lib's tests use `music_io/mocks` and never
  `music_io/web`: the web entry imports music_lib and would pull its own
  published dist back in.
- **`ToneJsMidiCodec` is shared by both platforms on purpose.** SMF encoding is
  byte manipulation with no platform APIs, and `@tonejs/midi` works under Metro.
  The seam exists so music_lib carries no MIDI dependency and a future ESM codec
  can replace this one without music_lib changing — it does **not**, by itself,
  remove CommonJS from the graph.
- **`@tonejs/midi` is read off the module namespace, not by named import.** It
  publishes CommonJS as `main` and ESM only via `module`, with no exports map, so
  whether a named import works depends on which build the resolver picked. Bun
  and Vite take the ESM build and are fine; Node's ESM loader takes `main` and
  cannot detect the named exports of a bundled CommonJS file. Local runs passed
  and CI failed.
- **There is no RN audio, and that is a decision, not a gap in the port.** The
  web engine is libfluidsynth compiled to WASM running in an `AudioWorklet`;
  React Native has no AudioWorklet, so there is nothing to port — an RN engine
  means a different implementation of the same `PlaybackEngine` interface (a
  native synth module, or `react-native-audio-api` plus a soundfont player).
  What was there before subclassed the Tone engine over
  `react-native-audio-api` and synthesised its own approximations of the
  instruments, so it could never match what the web plays; a wrong sound is
  worse than a clear error. `unavailablePlayback()` now throws from anything
  that would make a sound and stays a silent no-op for the lifecycle methods, so
  a shared component calling `pause()` on unmount does not crash the app. The
  historical spikes are in `spikes/tone-on-rn-audio-api.md`.
- **The two platforms play the same font by different means, and that is the
  design.** Web runs libfluidsynth (WebAssembly) in an `AudioWorklet`; React
  Native has neither — `react-native-audio-api` exposes no `addModule` and
  Hermes has no WebAssembly — so it plays **FluidR3 pre-rendered per note**
  instead, from Benjamin Gleitzman's packs, generated from the same
  `FluidR3_GM.sf2` the web plays as `FluidR3Mono_GM.sf3`. Every key of all 128
  melodic programs is a real recording, so nothing is pitch-shifted in range.
  What is lost is SF2's live per-zone filters, LFOs and modulator envelopes —
  expressive variation, not the instrument's identity. The engine that was
  deleted synthesised oscillator approximations, which is a different and much
  worse thing. See `spikes/rn-sample-playback.md`.
- **The transport is shared; only voicing is per platform.** `shared/playback/`
  holds score flattening, the note cursor, the dispatch window and the master
  trim, and both engines run it. `governor.ts` and `channel-allocator.ts`
  stayed in `web/` despite importing nothing — they are fluidsynth-specific in
  meaning (interpolation orders; 16 channels per synth instance) — and
  `soundfont-loader.ts` stayed because it uses the browser `caches` global.
  Import-free is not the same as platform-free.
- **The RN engine deliberately does not reuse the web engine's pump.** Merging
  the two transports behind a synth port is the obvious refactor and the wrong
  order: the web engine is verified on real devices and the RN one cannot be
  until it runs on a phone. Do that merge after RN audio is device-tested, not
  before.
- **Pack names are not GM slugs.** Punctuation is *removed*, not turned into a
  separator: `Honky-tonk Piano` is `honkytonk_piano` and `Lead 8 (bass + lead)`
  keeps the double underscore where the `+` was. That covers 127 of 128; program
  54 is a real naming disagreement (GM "Voice Oohs" vs. the catalogue's "Synth
  Voice"). `gm-pack-name.test.ts` checks all 128 against a vendored copy of the
  CDN manifest, because a wrong name is a 404, which parses to zero samples,
  which is an instrument that plays nothing with no error anywhere.
- **Drum kits are rendered here, not fetched.** The pre-rendered FluidR3 packs
  are the 128 *melodic* programs only, and no CDN publishes GM percussion under
  a licence this project can use — WebAudioFont, the one that has it, is
  GPL-3.0. So `scripts/build-percussion-packs.mjs` renders the eight GM kits out
  of the same `FluidR3Mono_GM.sf3` the web engine plays, with `fluidsynth` and
  `lame`, into the melodic packs' own format so one parser reads both. FluidR3
  is CC-BY 3.0, so redistributing the renderings is allowed with attribution
  (the script writes an `ATTRIBUTION.md` beside them). Output is ~1.1-1.7MB per
  kit; it is a build-time tool, run when the font changes, not part of
  `bun run build`.
- **The expression a recording cannot carry is measured back in**
  (`playback/expression.ts`, built by `scripts/measure-expression.mjs`). The
  packs are recordings taken at full velocity, so playing one softer is just the
  loud recording turned down — where fluidsynth also darkens it, shapes its
  release per instrument, and sustains it while held. Three fixes, all measured
  from the same `.sf3` the web plays:
  1. **Velocity is (v/127)², not v/127.** SF2's default velocity-to-attenuation
     modulator is 960cB concave; fluidsynth's concave table
     (`1 + (40/96)·log10(v/127)`) reduces exactly to a square. The linear curve
     the engine had played velocity 32 at 0.252 against a true 0.063 — **12dB
     too loud on every soft passage**, which flattens all dynamics.
  2. **A per-instrument low-pass** whose corner falls with velocity: piano goes
     ~4989Hz at v96 to ~556Hz at v16, strings barely move, violin and flute not
     at all. Only 57 of 128 instruments darken, and a node is built only when
     the corner is below 16kHz.
  3. **A per-instrument release**, median 0.56s measured, against the flat 80ms
     the engine applied to everything — seven times too short, chopping every
     released chord.
- **The expression table is measured, not extracted, and that is the
  interesting part.** The first attempt parsed `initialFilterFc` straight out of
  the `pdta` chunk (readable even in SF3 — only `sdta` is Vorbis-compressed). It
  gave Grand Piano a **300Hz** low-pass, which is plainly wrong: the rendered
  piano has energy out to 4.6kHz. The cause is layering — FluidR3's piano preset
  points at two instruments at once and the recording is their sum, so no single
  layer's generators describe it. Generators cannot be read off a layered
  preset; the rendered sound can. The script now renders all 128 programs at five
  velocities and finds where the quiet spectrum falls 3dB below the loud one,
  **after normalising both to the fundamental** — skipping that normalisation
  produced a table reading 281Hz for all 128, because a quiet note is quieter at
  every frequency and the first band examined already looks 3dB down.
- **Generated assets are pinned to the soundfont by hash.** Both
  `expression-table.ts` and the percussion packs are derived from
  `FluidR3Mono_GM.sf3` and regenerated by nobody. Each records the font's
  SHA-256, and music_app — which owns the font — asserts the match in
  `src/config/generated-assets.test.ts`. Without it a swapped font leaves RN
  playing kits and velocity curves from the old one, silently, presenting as
  "RN sounds subtly unlike web". The hash is read through
  `@sudobility/music_io/rn/expression-table`, a dependency-free subpath, because
  reaching it via the RN entry drags in optional peers a web app does not install.
- **Notes longer than 3.13 seconds used to go silent.** Every pack entry is
  exactly that long, whatever the instrument, so a whole note at 60bpm or a tied
  pad simply stopped sounding partway through with the gain envelope still
  holding a level over nothing. `sustain-loop.ts` loops a window inside the
  steady portion **spanning a whole number of periods of the sampled note** —
  which is known, since it is the pack entry being played, so no pitch detection
  is needed. Zero-crossing alignment alone was not enough: it removes the step
  discontinuity but not the *phase* one, so an arbitrary-length window ends
  part-way through a cycle and every harmonic restarts out of phase, audible as
  a buzz once a second on a held note. Only for the 79
  instruments measured as holding their level: looping a piano or a marimba
  would sustain a note that is supposed to die away, which is a worse and more
  obvious error than the truncation it fixes.
- **A drum note is never bent** (`exactSample`, not `nearestSample`). In a kit
  a note number names a *different instrument* — 38 is a snare, 42 a closed
  hi-hat — so reaching for the closest available slot answers a missing cowbell
  with a detuned tom, confidently. A slot the kit does not define plays nothing,
  which is what real hardware does; TR-808 genuinely leaves three of GM's slots
  empty. `percussionPackName` addresses a kit by the program that selects it,
  and goes through `gmKitAt`, because a percussion track's `midiProgram` is a
  kit and never agrees with the instrument table (Brush is 40; program 40 is
  Violin).
- **`percussionBase` has no default, deliberately.** The melodic packs have a
  CDN to fall back on; the kits are app-hosted, so there is nowhere to point.
  An app that ships scores with drums and never sets it gets a sentence naming
  the build script rather than silent percussion.
- **An export is rendered offline, not played into a file.** The engine
  schedules against a *live* clock and pumps 200ms at a time, so reusing it for
  export would make a render take as long as the piece. `RenderPlan` arrives
  fully resolved (seconds, not ticks; mute and solo already applied by
  `renderEvents` in music_lib), so `rn/audio/offline-render.ts` schedules the
  whole thing up front against an `OfflineAudioContext`. What it *does* share
  with the engine is `PackLibrary` and `planVoice` — the sample choice and the
  gain — which is what keeps the file a recording of what was heard rather than
  a second voicing that drifts. Note the velocity units differ: `RenderPlan`
  carries 0..1 and `planVoice` normalizes 0..127, so the renderer scales back up.
  Getting that backwards renders a file ~127x too quiet, which is why it has its
  own test.
- **Decoding borrows the OS decoder on both platforms, and always did on web.**
  `AudioContext.decodeAudioData` in a browser, `react-native-audio-api`'s
  `decodeAudioData` (0.13+) on RN — AVFoundation on iOS, MediaCodec on Android.
  Neither platform bundles a decoder, so both read wav, mp3 and `.mpa`. The RN
  codec used to sniff for a `RIFF` header and reject everything else; that was
  never a platform limit, only a consequence of the code living in `web/`.
  Both encoders moved to `shared/` for the same reason: wav is a header writer
  and mp3 is lamejs, neither of which has ever needed a browser.
- **`fast-xml-parser`, not `@xmldom/xmldom`,** for RN XML: xmldom ships CommonJS
  only. The adapter must keep `isArray` on for elements (so a one-measure part has
  the same shape as a two-measure one) and off for text nodes — and must not
  iterate a text-only element, which parses to a bare scalar whose
  `Object.entries` are a string's character indices. That recursed until the
  stack blew.
- **Every implementation must pass `runPlatformContract`, and declares its own
  audio stance to it.** Without the shared suite, web, RN and mocks would each
  be tested differently and could drift while all three stayed green — the exact
  failure a platform abstraction exists to prevent. The stance
  (`{ playback, offlineRender }`) is stated per entry rather than inferred,
  because "this platform cannot do audio" is a design decision and should read
  like one at the call site. It also fixed a real hole: the playback check used
  to be sixteen `typeof === 'function'` assertions, which a table of silent
  no-ops passes just as happily as one that refuses — a user presses play,
  nothing happens, nothing says why. A `'refuses'` platform must now actually
  throw from `initialize`/`loadScore`/`play`/`noteOn` and actually stay silent
  for the twelve lifecycle methods.

## Related Projects

- `music_types` — shared types, schemas and the platform interfaces this implements
- `music_lib` — domain model, commands, store; platform-free
- `music_app` — the web app; its composition root wires this package
- `music_client`, `music_api` — networking and backend
