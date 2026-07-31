import { describe, expect, it, vi } from 'vitest';

// The rn entry imports react-native-audio-api, which pulls in React Native's
// own Flow-typed source and cannot be bundled outside a Metro build. Faked
// here so this test can check what it is actually about: that the export map
// resolves and every entry agrees on its factory name.
vi.mock('react-native-audio-api', () => ({ AudioContext: class {} }));

describe('entry points', () => {
  it('every entry exports createMusicIo', async () => {
    // The export map is the whole mechanism -- Metro resolves `rn`, bundlers
    // resolve `web` -- so all three must stay importable and agree on the name.
    for (const entry of ['./web/index.js', './rn/index.js', './mocks/index.js']) {
      const mod = (await import(entry)) as { createMusicIo?: unknown };
      expect(typeof mod.createMusicIo, entry).toBe('function');
    }
  });
});
