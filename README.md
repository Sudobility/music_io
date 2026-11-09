# @sudobility/music_io

Platform IO implementations for Moosiac, for web and React Native.

This package implements the platform contracts from `@sudobility/music_types` so
that the domain package `@sudobility/music_lib` can stay free of any platform
library and run unchanged on both platforms. What it provides is **files and
audio**:

- the open/save layer over the score codecs (`createScoreFiles` — the
  `open*`/`save*` functions);
- audio import helpers (`audioMimeFor`, `isLongAudio`), re-exported from every
  entry;
- audio encode/decode — WAV and MP3 encoders (pure JS), decoding via the OS
  (`AudioContext.decodeAudioData` on web, `react-native-audio-api` on RN);
- file export / filesystem access;
- XML parsing (`DOMParser` on web, `fast-xml-parser` on RN);
- live MIDI input (web only; React Native reports `isSupported()` false).

It deliberately does **not** contain playback engines or offline audio rendering
(those live in `music_player`) or the note-format codecs — MIDI, MOD and
MusicXML parsing live in `@sudobility/music_codecs`. This package only
orchestrates those codecs with file IO.

## Entries

The export map resolves `@sudobility/music_io` to the web entry by default and to
the React Native entry under Metro's `react-native` condition, so app code can
import the package name and never branch on platform.

- `@sudobility/music_io` — conditional web/RN entry (`createMusicIo()`).
- `@sudobility/music_io/web` — browser implementation.
- `@sudobility/music_io/rn` — React Native implementation.
- `@sudobility/music_io/mocks` — test doubles (real WAV encoding and the real
  score codecs; MP3/decode are stubbed), shipped so consumers' tests reuse them.

## Install

The `@sudobility` scope resolves to GitHub Packages (see `.npmrc`), so an
authenticated `~/.npmrc` with a GitHub token that can read the scope is required.

```bash
bun install
```

Runtime dependencies are `@breezystack/lamejs` (MP3 encoding) and
`@sudobility/music_codecs`. `fast-xml-parser`, `react-native-fs` and
`react-native-share` are **optional** peer dependencies (also kept as
devDependencies so a clean CI install typechecks).

## Build, test, lint

```bash
bun run build       # tsc -p tsconfig.build.json → dist/ (web, rn, mocks)
bun run test:unit   # Vitest (use this, not `bun test`)
bun run test:watch  # Vitest in watch mode
bun run lint        # ESLint over src
bun run typecheck   # tsc --noEmit
bun run verify      # typecheck + lint + test:unit + build; run before pushing
bun run clean       # remove dist
```

This is a TypeScript library (strict, ESM only); there is no app to run — it is
consumed by `music_app` and the React Native apps at their composition root.
Every implementation (web, rn, mocks) passes the shared `runPlatformContract`
suite in `src/contract/`.

## Layout

- `src/web/` — web implementations (`WebXmlParser`, `WebFileExporter`, web audio
  codec, `web-midi-input.ts`).
- `src/rn/` — React Native implementations (`RNXmlParser`, `RNFileExporter`,
  `createRNAudioCodec`).
- `src/shared/` — platform-free logic: `score-files.ts`, `audio-import.ts`, the
  WAV/MP3 encoders, the `MusicIo` bundle type, `unsupported-midi-input.ts`.
- `src/mocks/` — test doubles. `src/contract/` — the contract suite.

See `CLAUDE.md` for the architectural boundaries and gotchas.
