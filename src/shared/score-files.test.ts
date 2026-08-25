/**
 * The open/save layer: one call per import or export, with the codec pairing
 * done here rather than in a UI component.
 */
import { describe, expect, it } from "vitest";
import { defaultMidiImportOptions } from "@sudobility/music_codecs";
import { buildMod } from "@sudobility/music_codecs/fixtures";
import { createEmptyScore } from "@sudobility/music_types";
import { createMusicIo } from "../mocks/index.js";

/**
 * A minimal score, built here rather than borrowed.
 *
 * `music_codecs`' `twinkleScore` lives in its `src/test/` tree, which its build
 * excludes — only the tracker builders ship from `/fixtures`. This layer is one
 * codec call plus one file write, so what the notes are does not matter; that a
 * score goes in and comes back does.
 */
function testScore() {
  return createEmptyScore({
    title: "Twinkle",
    measures: 2,
    tracks: [{ name: "Piano" }],
  });
}

/** The mock exporter records what it was handed instead of writing it. */
function savedFiles(io: ReturnType<typeof createMusicIo>) {
  return (
    io.fileExporter as unknown as { saved: { name: string; data: unknown }[] }
  ).saved;
}

describe("score files", () => {
  it("round-trips a score through MIDI with no codec at the call site", async () => {
    const io = createMusicIo();
    await io.saveMidi(testScore(), "Twinkle.mid");

    const last = savedFiles(io).at(-1)!;
    expect(last.name).toBe("Twinkle.mid");

    // Read back through the other half of the layer. Asserted on the analysis
    // rather than on imported tracks: the fixture is rests only, and the
    // importer drops a track with no notes — correctly, but it would make this
    // look like a round-trip failure.
    const bytes = (last.data as Uint8Array).buffer as ArrayBuffer;
    const summary = io.analyzeMidi(bytes);
    expect(summary.ppq).toBe(testScore().ppq);

    const back = io.openMidi(bytes, defaultMidiImportOptions(summary));
    expect(back.warnings).toBeDefined();
  });

  it("opens a tracker module and returns both the module and the score", () => {
    const io = createMusicIo();
    // Both halves, because the caller needs both: the score to open, and the
    // module to name the project after.
    const { module, score } = io.openTracker(buildMod({ title: "Elysium" }));
    expect(module.format).toBe("mod");
    expect(score.tracks.length).toBeGreaterThan(0);
  });

  it("writes MusicXML the importer reads back", async () => {
    const io = createMusicIo();
    await io.saveMusicXml(testScore(), "Twinkle.musicxml");

    const last = savedFiles(io).at(-1)!;
    expect(last.name).toBe("Twinkle.musicxml");
    expect(String(last.data)).toContain("score-partwise");
  });

  it("encodes and writes audio without knowing how it was rendered", async () => {
    const io = createMusicIo();
    // PCM in, file out. The renderer lives in music_player and this package
    // never holds a reference to a running synth.
    await io.saveAudio(new Float32Array(4410), 44100, "wav", "Piece.wav");

    expect(savedFiles(io).at(-1)!.name).toBe("Piece.wav");
  });
});
