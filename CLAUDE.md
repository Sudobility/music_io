# music_io

Platform implementations for ScoreSmith: playback, XML parsing, file export and
the MIDI codec, for web and React Native. One of six repos in the family — see
`music_app/docs/architecture.md`.

The contracts live in `@sudobility/music_types`; this package implements them so
`@sudobility/music_lib` can stay free of any platform library and run unchanged
on both platforms.

## Tech Stack

- TypeScript (strict, ESM only), Bun, **Vitest** (not `bun test`)
- `tone` (web audio), `react-native-audio-api` (RN audio), `@tonejs/midi` (SMF
  codec), `fast-xml-parser` (RN XML) — **all optional peer dependencies**

## Commands

- `bun run verify` — typecheck + lint + test + build. Run before any push.
- `bun run test` — Vitest

## Structure

- `src/web/` — `TonePlaybackEngine` (moved here from music_lib), `WebXmlParser`, `WebFileExporter`
- `src/rn/` — `RNPlaybackEngine`, `RNXmlParser`, `RNFileExporter`, plus `types.d.ts` stubs for the native modules
- `src/shared/` — the `MusicIo` bundle type and `ToneJsMidiCodec`, used by both platforms
- `src/mocks/` — test doubles, including a small hand-rolled XML reader
- `src/contract/` — `runPlatformContract`, the suite every entry is held to

## Gotchas

- **Runtime `dependencies` stays empty.** Every platform library is an optional
  peer, so a React Native app never has `tone` in its dependency graph. This is
  the `sudojo_lib` convention and the reason this package exists.
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
- **RN playback is unverified on a device.** `RNPlaybackEngine` subclasses the
  Tone engine and swaps in `react-native-audio-api`'s context. That library needs
  `react-native` at import time, so no test here can prove Tone runs on it — see
  `spikes/tone-on-rn-audio-api.md` for the evidence and the contingency. The
  contract suite fakes the native module, so it proves the XML, MIDI and
  interface-shape guarantees and **not** that sound comes out.
- **`fast-xml-parser`, not `@xmldom/xmldom`,** for RN XML: xmldom ships CommonJS
  only. The adapter must keep `isArray` on for elements (so a one-measure part has
  the same shape as a two-measure one) and off for text nodes — and must not
  iterate a text-only element, which parses to a bare scalar whose
  `Object.entries` are a string's character indices. That recursed until the
  stack blew.
- **Every implementation must pass `runPlatformContract`.** Without it web, RN
  and mocks would each be tested differently and could drift while all three
  stayed green, which is the exact failure a platform abstraction exists to
  prevent.

## Related Projects

- `music_types` — shared types, schemas and the platform interfaces this implements
- `music_lib` — domain model, commands, store; platform-free
- `music_app` — the web app; its composition root wires this package
- `music_client`, `music_api` — networking and backend
