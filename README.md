# music_io

Platform IO implementations for Moosiac.

This package implements the platform interfaces from `@sudobility/music_types`:
playback, offline audio rendering, audio codecs, XML parsing, MIDI/MOD codecs,
and file export. App code normally imports `@sudobility/music_io`; the package
export map resolves that to the web entry by default and the React Native entry
under Metro's `react-native` condition.

## Entries

- `@sudobility/music_io` — conditional web/RN entry.
- `@sudobility/music_io/web` — browser implementation.
- `@sudobility/music_io/rn` — React Native implementation.
- `@sudobility/music_io/mocks` — test doubles with real MIDI/MOD/WAV codecs.
- `@sudobility/music_io/rn/expression-table` — dependency-light generated-asset metadata.

## Development

```bash
bun install
bun run verify
```

`bun run verify` runs typecheck, ESLint, Vitest, and the TypeScript build.
