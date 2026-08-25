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
});
