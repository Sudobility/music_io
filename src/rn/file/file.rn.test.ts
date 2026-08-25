import { describe, expect, it, vi } from "vitest";
import { RNFileExporter } from "./file.rn.js";
import type { RNFileExporterDeps } from "./file.rn.js";

type Entry = { name: string; path: string; mtime?: Date | null };

/**
 * A fake `react-native-fs` and `react-native-share`.
 *
 * `existing` seeds the export directory, so a test can say what was left behind
 * by earlier saves and assert what survives this one.
 */
function deps(
  existing: Array<{ name: string; minutesAgo: number }> = [],
  exportIds: string[] = ["save-1"],
) {
  let exportIndex = 0;
  const writeFile = vi.fn(
    async (_path: string, _contents: string, _encoding: string) => {},
  );
  const mkdir = vi.fn(async (_path: string) => {});
  const unlink = vi.fn(async (_path: string) => {});
  const open = vi.fn(async (_options: Record<string, unknown>) => undefined);
  const makeExportId = vi.fn(
    () => exportIds[exportIndex++] ?? `save-${exportIndex}`,
  );
  const readDir = vi.fn(async (dir: string): Promise<Entry[]> =>
    existing.map(({ name, minutesAgo }) => ({
      name,
      path: `${dir}/${name}`,
      mtime: new Date(Date.UTC(2026, 0, 1, 12, 0) - minutesAgo * 60_000),
    })),
  );
  const loadModules: NonNullable<
    RNFileExporterDeps["loadModules"]
  > = async () => ({
    fs: { CachesDirectoryPath: "/cache", writeFile, mkdir, readDir, unlink },
    share: { open },
  });
  return { writeFile, mkdir, readDir, unlink, open, loadModules, makeExportId };
}

const EXPORTS = "/cache/scoresmith-exports";
const SAVE_1 = `${EXPORTS}/save-1`;

describe("RNFileExporter", () => {
  it("writes bytes as base64 and opens the share sheet", async () => {
    const fakes = deps();

    await new RNFileExporter({
      loadModules: fakes.loadModules,
      makeExportId: fakes.makeExportId,
    }).save("score.mid", new Uint8Array([1, 2, 255]), "audio/midi");

    expect(fakes.writeFile).toHaveBeenCalledWith(
      `${SAVE_1}/score.mid`,
      "AQL/",
      "base64",
    );
    expect(fakes.open).toHaveBeenCalledWith({
      url: `file://${SAVE_1}/score.mid`,
      type: "audio/midi",
      failOnCancel: false,
    });
  });

  it("pads base64 for byte lengths that are not multiples of three", async () => {
    const one = deps();
    await new RNFileExporter({
      loadModules: one.loadModules,
      makeExportId: one.makeExportId,
    }).save("one.bin", new Uint8Array([1]), "application/octet-stream");
    expect(one.writeFile).toHaveBeenCalledWith(
      `${SAVE_1}/one.bin`,
      "AQ==",
      "base64",
    );

    const two = deps();
    await new RNFileExporter({
      loadModules: two.loadModules,
      makeExportId: two.makeExportId,
    }).save("two.bin", new Uint8Array([1, 2]), "application/octet-stream");
    expect(two.writeFile).toHaveBeenCalledWith(
      `${SAVE_1}/two.bin`,
      "AQI=",
      "base64",
    );
  });

  it("writes text as utf8", async () => {
    const fakes = deps();

    await new RNFileExporter({
      loadModules: fakes.loadModules,
      makeExportId: fakes.makeExportId,
    }).save("score.musicxml", "<score/>", "application/xml");

    expect(fakes.writeFile).toHaveBeenCalledWith(
      `${SAVE_1}/score.musicxml`,
      "<score/>",
      "utf8",
    );
  });

  it("keeps filenames inside the export directory", async () => {
    const fakes = deps();

    await new RNFileExporter({
      loadModules: fakes.loadModules,
      makeExportId: fakes.makeExportId,
    }).save("../nested\\score.mid", new Uint8Array([1]), "audio/midi");

    expect(fakes.writeFile.mock.calls[0]?.[0]).toBe(
      `${SAVE_1}/.._nested_score.mid`,
    );
    expect(fakes.open.mock.calls[0]?.[0]).toMatchObject({
      url: `file://${SAVE_1}/.._nested_score.mid`,
    });
  });

  it("does not allow dot-directory filenames", async () => {
    const fakes = deps();

    await new RNFileExporter({
      loadModules: fakes.loadModules,
      makeExportId: fakes.makeExportId,
    }).save("..", new Uint8Array([1]), "application/octet-stream");

    expect(fakes.writeFile.mock.calls[0]?.[0]).toBe(`${SAVE_1}/export`);
  });

  it("strips a NUL, which would truncate the name at the OS layer", async () => {
    const fakes = deps();

    await new RNFileExporter({
      loadModules: fakes.loadModules,
      makeExportId: fakes.makeExportId,
    }).save("score\0.mid", new Uint8Array([1]), "audio/midi");

    expect(fakes.writeFile.mock.calls[0]?.[0]).toBe(`${SAVE_1}/score.mid`);
  });

  it("uses a fresh export directory for repeated filenames", async () => {
    const fakes = deps([], ["first", "second"]);
    const exporter = new RNFileExporter({
      loadModules: fakes.loadModules,
      makeExportId: fakes.makeExportId,
    });

    await exporter.save("score.wav", new Uint8Array([1]), "audio/wav");
    await exporter.save("score.wav", new Uint8Array([2]), "audio/wav");

    expect(fakes.writeFile.mock.calls.map((call) => call[0])).toEqual([
      `${EXPORTS}/first/score.wav`,
      `${EXPORTS}/second/score.wav`,
    ]);
    expect(
      fakes.open.mock.calls.map((call) => (call[0] as { url: string }).url),
    ).toEqual([
      `file://${EXPORTS}/first/score.wav`,
      `file://${EXPORTS}/second/score.wav`,
    ]);
  });

  // ---- cleanup ------------------------------------------------------------

  it("exports into a directory of its own, not the shared cache root", async () => {
    // Sweeping `CachesDirectoryPath` itself would be indistinguishable from
    // deleting the OS's files and every other library's.
    const fakes = deps();

    await new RNFileExporter({
      loadModules: fakes.loadModules,
      makeExportId: fakes.makeExportId,
    }).save("a.mid", "", "audio/midi");

    expect(fakes.mkdir).toHaveBeenCalledWith(EXPORTS);
    expect(fakes.mkdir).toHaveBeenCalledWith(SAVE_1);
    expect(fakes.writeFile.mock.calls[0]?.[0]).toBe(`${SAVE_1}/a.mid`);
  });

  it("sweeps away exports left behind by earlier saves", async () => {
    // The bug: every export used to leave a copy in the cache forever, and an
    // audio export is tens of megabytes.
    const fakes = deps([
      { name: "newest.wav", minutesAgo: 1 },
      { name: "older.wav", minutesAgo: 30 },
      { name: "oldest.wav", minutesAgo: 300 },
    ]);

    await new RNFileExporter({
      loadModules: fakes.loadModules,
      makeExportId: fakes.makeExportId,
    }).save("new.mid", "", "audio/midi");

    expect(fakes.unlink.mock.calls.map((call) => call[0])).toEqual([
      `${EXPORTS}/older.wav`,
      `${EXPORTS}/oldest.wav`,
    ]);
  });

  it("spares the most recent export, which may still be in a share sheet", async () => {
    // `share.open()` resolves when the sheet is dismissed, not when the
    // receiving app has finished reading — so the previous file is left alone
    // and only goes when the save after this one arrives.
    const fakes = deps([{ name: "previous.wav", minutesAgo: 1 }]);

    await new RNFileExporter({
      loadModules: fakes.loadModules,
      makeExportId: fakes.makeExportId,
    }).save("new.mid", "", "audio/midi");

    expect(fakes.unlink).not.toHaveBeenCalled();
  });

  it("cleans up before writing, so it can never delete what it is about to share", async () => {
    const fakes = deps([
      { name: "a.wav", minutesAgo: 10 },
      { name: "b.wav", minutesAgo: 20 },
    ]);
    const order: string[] = [];
    fakes.unlink.mockImplementation(async () => {
      order.push("unlink");
    });
    fakes.writeFile.mockImplementation(async () => {
      order.push("write");
    });

    await new RNFileExporter({
      loadModules: fakes.loadModules,
      makeExportId: fakes.makeExportId,
    }).save("new.mid", "", "audio/midi");

    expect(order).toEqual(["unlink", "write"]);
  });

  it("still exports when the cleanup fails", async () => {
    // Housekeeping must not cost the user their export.
    const fakes = deps([
      { name: "a.wav", minutesAgo: 10 },
      { name: "b.wav", minutesAgo: 20 },
    ]);
    fakes.readDir.mockRejectedValue(new Error("cache unreadable"));

    await expect(
      new RNFileExporter({
        loadModules: fakes.loadModules,
        makeExportId: fakes.makeExportId,
      }).save("new.mid", "", "audio/midi"),
    ).resolves.toBeUndefined();
    expect(fakes.writeFile).toHaveBeenCalled();
    expect(fakes.open).toHaveBeenCalled();
  });

  it("still exports when one file cannot be removed", async () => {
    const fakes = deps([
      { name: "a.wav", minutesAgo: 10 },
      { name: "locked.wav", minutesAgo: 20 },
    ]);
    fakes.unlink.mockRejectedValue(new Error("in use"));

    await expect(
      new RNFileExporter({
        loadModules: fakes.loadModules,
        makeExportId: fakes.makeExportId,
      }).save("new.mid", "", "audio/midi"),
    ).resolves.toBeUndefined();
    expect(fakes.writeFile).toHaveBeenCalled();
  });
});
