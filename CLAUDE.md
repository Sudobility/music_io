# music_io

> **Git policy — never auto-commit or auto-push.** Leave your work in the working tree.
> Run `git commit`, `git push`, `gh pr create`, or `scripts/push_all.sh` **only when the user
> explicitly asks in that turn**. Approval for an earlier change does not carry forward, and
> finishing a task is not permission to commit it.

Platform implementations for Moosiac: score and audio **files**, XML parsing and
live MIDI input, for web and React Native. One of seven repos in the family
— see `music_app/docs/architecture.md`.

The contracts live in `@sudobility/music_types`; this package implements them so
`@sudobility/music_lib` can stay free of any platform library and run unchanged
on both platforms.

**Two lines this package holds.** *Notes go to `music_codecs`, samples stay
here.* And *sound goes to `music_player`, bytes stay here* — the engines, the
transport and offline rendering all left with the music_player split. Audio
export renders there and hands back PCM; this package encodes it and writes the
file, which is why it needs no reference to a running synth.

The first line, in full:
A format that carries notes — MIDI, MusicXML, the tracker modules — is byte
arithmetic against a published spec, runs identically on web, React Native and
the server, and lives in `@sudobility/music_codecs`. A format that carries
sampled sound — WAV, MP3 — needs a real audio context and lives here, with
playback, file export and MIDI input.

The score codecs used to be here, injected as `midiCodec` and `modCodec` on
`MusicIo` for surface consistency. The cost was concrete: `ToneJsMidiCodec` had
to be hand-copied into music_lib, music_api and music_codecs' own test folder,
because the one real implementation sat in the platform package where the
server could not reach it. Two things stayed behind and are **not** exceptions
to the rule: `XmlParser`, because `DOMParser` and `fast-xml-parser` are
genuinely different implementations rather than one shared module pretending to
be two, and `MidiInput`, which is a device rather than a file format.

## Tech Stack

- TypeScript (strict, ESM only), Bun, **Vitest** (not `bun test`)
- `js-synthesizer` (libfluidsynth in an AudioWorklet — the web engine),
  `fast-xml-parser` (RN XML), `react-native-fs` /
  `react-native-share` (RN file export) — **all optional peer dependencies**.
  `@breezystack/lamejs` is the one runtime dependency; see Gotchas. `tone` is
  gone: the web engine is the soundfont synth, and RN has no engine at all.

## Commands

- `bun run verify` — typecheck + lint + test + build. Run before any push.
- `bun run test` — Vitest

## Structure

- `src/web/` — `SoundfontPlaybackEngine` and its scheduling/mixing modules (~1,500 lines, the bulk of this package), the offline soundfont renderer, `WebXmlParser`, `WebFileExporter`
- `src/rn/` — `RNXmlParser`, `RNFileExporter`, a full audio codec (OS decoder via `react-native-audio-api`, shared encoders), and `playback/` — `RNSamplePlaybackEngine`, a sample-based FluidR3 engine
- `src/shared/` — the `MusicIo` bundle type, the wav/mp3 encoders and mono mixdown, `midi/unsupported-midi-input.ts`, and `playback/` (score flattening, note cursor, dispatch window, master trim, MIDI maths) — the transport half both engines run. Everything here is pure logic over bytes and numbers, which is the test for belonging in it. **That test is necessary but not sufficient**: the MIDI and tracker codecs were pure logic over bytes too, and belonged in `@sudobility/music_codecs` because the *server* needs them. What stays here is what a platform must provide
- `src/mocks/` — test doubles, including a small hand-rolled XML reader
- `src/contract/` — `runPlatformContract`, the suite every entry is held to

## Gotchas

- **One fact, one declaration — and `src/__single-source.test.ts` enforces it.** A constant restated in a second package agrees with the first right up until one of them is edited, and nothing fails when they part: the build is clean, the types match, and the only symptom is a wrong sound or a picker quietly missing an entry. Measured across the family, 23 UPPER_CASE constants were declared in more than one repo — `CC_VOLUME` three times, `DYNAMICS` four, `C_MAJOR` five, and `DEFAULT_TIME_SIGNATURE` in four places under two names. The guard reads the list of names **from music_types at runtime** rather than restating it, because a check against duplication that duplicates what it checks would drift like everything else; its `ALLOWED` list is empty on purpose, so an exemption is a decision somebody writes down. Two shapes matter beyond the constants themselves. **A closed vocabulary is declared as an array and the type read off it** (`export const DYNAMICS = [...] as const; export type Dynamic = (typeof DYNAMICS)[number];`) — a TypeScript union has no runtime form, so anything that must *validate* a value has to write the list out again, which is exactly how music_api's decoder came to check generated music against its own private copy. **A label or option list keyed by the vocabulary is a `Record<T, ...>`, never a parallel array** — a record fails to compile when a member is added, an array silently goes on offering the old set; that is why the inspector's picker lists are `ACCIDENTAL_OPTIONS`/`ARTICULATION_OPTIONS` built from the vocabulary rather than `ACCIDENTALS`/`ARTICULATIONS` retyped. Test fixtures follow the same rule: the score fixtures live once, in `@sudobility/music_types/test`, and a package that needs a rendering fixture of its own re-exports them and adds to them.

- **The `open*`/`save*` layer is orchestration, not a capability.** Eight methods
  on the `MusicIo` bundle, each a codec call paired with a file write:
  `openMidi`, `analyzeMidi`, `openTracker`, `openMusicXml`, `saveMidi`,
  `saveTracker`, `saveMusicXml`, `saveAudio`. They live on the bundle because
  the save half needs `fileExporter` and the MusicXML half needs `xmlParser`,
  both already here. The app used to do that pairing itself, which is why
  `AppLayout` grew four near-identical export handlers and the MusicXML dialog
  constructed a service around `xmlParser`.
- **`open*`/`save*`, never `import*`/`export*`.** `@sudobility/music_codecs`
  already exports `importMidi`/`exportMidi`, and two identically-named functions
  in packages the app imports together is a collision that gets resolved wrongly
  under time pressure.
- **`saveTracker` takes a `TrackerModule`, not a `Score`, and that is
  deliberate.** A tracker export is lossy in three counted ways — the row grid,
  the channel cap, the note range — and the app shows those numbers *before*
  writing: a clean fit costs no extra click, anything lost shows the report
  first. A `saveTracker(score, …)` returning the report could only report after
  writing, inverting that. So the caller runs `scoreToTracker` when it wants the
  fit, and this writes what came out.
- **`saveAudio` takes PCM, and that asymmetry with the score formats is the
  point.** This package orchestrates a *codec*, which is a pure function it may
  call. It does not orchestrate *rendering*, which is a live synth with
  platform-bound state in `@sudobility/music_player`. Keeping it out means this
  package never holds a reference to a running synth, and the two platform
  packages do not depend on each other. The app renders, then hands the samples
  over.

- **This package must not import `@sudobility/music_lib` or `@sudobility/music_player`.** The two platform packages deliberately do not depend on each other, which is why audio export is orchestrated by the caller. It is the platform layer — bytes, audio, files — and music_lib is the domain. `src/contract/no-music-lib.test.ts` enforces it over both `src/` and `package.json`. The rule held once and was lost gradually: `PlaybackEngine.loadScore` took a `Score`, and an engine holding a score then needed tempo maths, tie joining and the GM tables to do anything with it. By the end the two packages were mutually dependent and neither could be type-checked at release time until the other had published. Engines now take a `PlaybackPlan` — notes in ticks with their ids, metronome clicks, tracks with their **resolved** GM voice, and tick↔second conversion as a `TempoConversion` — so every musical question is already answered before the platform layer sees it. Engine tests build plans with `shared/playback/test-plan.ts` rather than importing a score fixture.
- **The export map is the whole mechanism.** `"react-native"` resolves to
  `dist/rn`, `"default"` to `dist/web`, so app code writes one import and never
  branches on platform. `./web`, `./rn` and `./mocks` stay addressable for tests.
- **Optional peers must also be devDependencies.** CI does a clean install; a
  library that only exists in a developer's `node_modules` from an ad-hoc
  `bun add` will typecheck locally and fail in CI. That happened.


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
- **Every implementation must pass `runPlatformContract`.** It no longer takes a
  capabilities argument: that existed to describe the two capabilities that were
  not universal — playback and offline render — and both left with
  `music_player`. Everything remaining is universal.


## Related Projects

- `music_types` — shared types, schemas and the platform interfaces this implements
- `music_lib` — domain model, commands, store; platform-free
- `music_app` — the web app; its composition root wires this package
- `music_client`, `music_api` — networking and backend

## Git Workflow

- Do not use feature branches for code changes. Always stay on the current branch.
