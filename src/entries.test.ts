import { describe, expect, it } from "vitest";

describe("entry points", () => {
  it("every entry exports createMusicIo", async () => {
    // The export map is the whole mechanism -- Metro resolves `rn`, bundlers
    // resolve `web` -- so all three must stay importable and agree on the name.
    for (const entry of [
      "./web/index.js",
      "./rn/index.js",
      "./mocks/index.js",
    ]) {
      const mod = (await import(entry)) as { createMusicIo?: unknown };
      expect(typeof mod.createMusicIo, entry).toBe("function");
    }
  });

  it("every entry exports the same audio-import rules", async () => {
    // Both apps offer the same recording import, so whichever branch of the
    // export map an app resolves must hand it the same list.
    const shared = await import("./shared/audio-import.js");
    for (const entry of [
      "./web/index.js",
      "./rn/index.js",
      "./mocks/index.js",
    ]) {
      const mod = (await import(entry)) as Record<string, unknown>;
      expect(mod.AUDIO_IMPORT_EXTENSIONS, entry).toBe(
        shared.AUDIO_IMPORT_EXTENSIONS,
      );
      expect(mod.AUDIO_MIME, entry).toBe(shared.AUDIO_MIME);
      expect(mod.audioMimeFor, entry).toBe(shared.audioMimeFor);
      expect(mod.isLongAudio, entry).toBe(shared.isLongAudio);
    }
  });
});
