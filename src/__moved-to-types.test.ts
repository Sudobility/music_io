/**
 * The audio-import vocabulary and the `ScoreFiles` contract live in
 * music_types, once.
 *
 * The extension list and MIME table are vocabulary; `ScoreFiles` is a platform
 * contract, beside `XmlParser` and `FileExporter`, and no longer needs a codec
 * type now those are in music_types too. music_lib re-exports music_types
 * wholesale, so a name declared or re-exported here again reaches an app by two
 * routes.
 */
import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";

const MOVED = [
  "AUDIO_IMPORT_EXTENSIONS",
  "AudioImportExtension",
  "AUDIO_MIME",
  "ScoreFiles",
];

describe("names that moved to music_types", () => {
  it("are neither declared nor re-exported by any source file", () => {
    const offenders: string[] = [];
    for (const file of globSync("src/**/*.ts")) {
      if (file.includes(".test.")) continue;
      const text = readFileSync(file, "utf8");
      for (const name of MOVED) {
        const declared = new RegExp(
          `export\\s+(?:type|interface|const|class|function|enum)\\s+${name}\\b`,
        );
        const reexported = new RegExp(
          `export\\s+(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}`,
        );
        if (declared.test(text) || reexported.test(text))
          offenders.push(`${name} in ${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("are not exported by any entry at runtime", async () => {
    for (const entry of [
      "./web/index.js",
      "./rn/index.js",
      "./mocks/index.js",
    ]) {
      const mod = (await import(entry)) as Record<string, unknown>;
      expect(
        MOVED.filter((name) => name in mod),
        entry,
      ).toEqual([]);
    }
  });

  it("publishes no export-map entry for a module it does not have", () => {
    // `./rn/expression-table` and `./rn/gm-pack-name` pointed at files that
    // are music_player's; an entry for a missing file resolves to nothing.
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      exports: Record<string, { types?: string; default?: string }>;
    };
    for (const [key, target] of Object.entries(pkg.exports)) {
      const types = (target as { types?: string }).types;
      if (!types) continue;
      const source = types
        .replace(/^\.\/dist\//, "src/")
        .replace(/\.d\.ts$/, ".ts");
      expect(globSync(source), key).toEqual([source]);
    }
  });
});
