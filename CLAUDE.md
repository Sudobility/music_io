# @sudobility/music_io

> **Git: never auto-commit or auto-push.** Leave work in the working tree; run
> `git commit`/`push`/`gh pr create`/`scripts/push_all.sh` only when the user asks
> in that turn. Stay on the current branch — no feature branches for code changes.

Platform implementations for Moosiac: **files and audio**, for web and React
Native. The open/save layer over the score codecs (`createScoreFiles`), reading
an audio file's name/size (`audioMimeFor`, `isLongAudio`), audio encode/decode,
the filesystem, XML parsing and live MIDI input. It implements the contracts in
`@sudobility/music_types` so `@sudobility/music_lib` can stay free of any platform
library and run unchanged on both platforms.

**Two boundary lines this package holds.** *Notes go to `music_codecs`, samples
stay here* — a format carrying notes (MIDI, MusicXML, trackers) is byte arithmetic
against a spec and runs identically on web/RN/server, so it lives in music_codecs;
a format carrying sampled sound (WAV, MP3) needs a real audio context and lives
here. *Sound goes to `music_player`, bytes stay here* — the engines, transport and
offline render left with the music_player split; audio export renders **there** and
hands back PCM, which this package encodes and writes (so it never references a
running synth). Two things stayed and are **not** exceptions: `XmlParser`
(`DOMParser` vs `fast-xml-parser` are genuinely different) and `MidiInput` (a
device, not a file format).

## Commands

- `bun run verify` — typecheck + lint + test:unit + build. Before any push.
- `bun run test:unit` — Vitest (not `bun test`). TypeScript strict, ESM only.

`fast-xml-parser` / `react-native-fs` / `react-native-share` are **optional peer
deps**. Runtime deps are `@breezystack/lamejs` (mp3; see below) and `music_codecs`.
No synth — `js-synthesizer` and both engines are music_player's. The export map is
the whole platform mechanism: `"react-native"` → `dist/rn`, `"default"` → `dist/web`;
`./web`, `./rn`, `./mocks` stay addressable for tests.

## Structure

- `src/web/` — `WebXmlParser`, `WebFileExporter`, web audio codec, `web-midi-input.ts`.
- `src/rn/` — `RNXmlParser`, `RNFileExporter`, full audio codec (OS decoder via
  `react-native-audio-api`, shared encoders).
- `src/shared/` — `score-files.ts` (`createScoreFiles`, the `open*`/`save*` layer),
  `audio-import.ts` (`audioMimeFor`/`isLongAudio`, re-exported from every entry),
  the `MusicIo` bundle type, wav/mp3 encoders, `toMono`, `unsupported-midi-input.ts`.
  Everything here is pure logic over bytes — necessary but not sufficient for
  belonging (the codecs are pure too but live in music_codecs because the server needs them).
- `src/mocks/` — test doubles. `src/contract/` — `runPlatformContract`, the suite every entry passes.

## Gotchas

- **This package must not import `music_lib` or `music_player`**
  (`src/contract/no-music-lib.test.ts`, over `src/` and `package.json`). The two
  platform packages deliberately don't depend on each other, which is why audio
  export is orchestrated by the caller.
- **One fact, one declaration** (`src/__single-source.test.ts`): a constant
  restated across packages drifts silently; the guard reads the name list from
  music_types at runtime, `ALLOWED` empty on purpose. `src/__moved-to-types.test.ts`
  keeps `ScoreFiles`, `XmlParser`, `FileExporter`, `AUDIO_IMPORT_EXTENSIONS` etc.
  out — they're music_types'.
- **`open*`/`save*`, never `import*`/`export*`** — music_codecs already exports
  `importMidi`/`exportMidi`; same-named functions in both collide. The layer is
  orchestration (codec call + file write), living on the bundle because the save
  half needs `fileExporter` and the MusicXML half needs `xmlParser`.
- **`saveTracker` takes a `TrackerModule`, `saveAudio` takes PCM** — both
  deliberate. Tracker export is lossy in three counted ways the app must report
  *before* writing, so the caller runs `scoreToTracker`; audio is a *render* (a
  live synth in music_player), not a codec, so the app renders then hands samples over.
- **`@breezystack/lamejs` is a runtime `dependency`, not an optional peer** — the
  one exception. `shared/audio/mp3.ts` imports it statically and both audio codecs
  import that module, and `AudioCodec.encodeMp3` is synchronous in music_types so
  it can't be lazy. It's pure JS under Metro, not a platform library.
- **Optional peers must also be devDependencies** — CI does a clean install, so a
  lib present only from an ad-hoc `bun add` typechecks locally and fails CI.
- **Decoding borrows the OS decoder on both platforms** —
  `AudioContext.decodeAudioData` (web) / `react-native-audio-api` 0.13+ (RN:
  AVFoundation / MediaCodec). Both read wav, mp3 and `.mpa`; the old RIFF sniff was
  never a platform limit.
- **`fast-xml-parser`, not `@xmldom/xmldom`** (xmldom is CJS only): keep `isArray`
  on for elements, off for text; don't iterate a text-only element (its
  `Object.entries` are a string's char indices — the stack blew).
- **Every implementation passes `runPlatformContract`** — no longer takes a
  capabilities argument; playback and offline render (the non-universal ones) left with music_player.

## Related

`music_types` (contracts implemented here) · `music_lib` (domain, platform-free) ·
`music_app` (web; wires this at its composition root) · `music_client`, `music_api`
