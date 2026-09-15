import { describe, expect, it } from "vitest";
import {
  AUDIO_IMPORT_EXTENSIONS,
  AUDIO_MIME,
  audioMimeFor,
  isLongAudio,
} from "./audio-import.js";

describe("audio import", () => {
  it("offers the recording formats the transcriber accepts, each with a MIME type", () => {
    expect(AUDIO_IMPORT_EXTENSIONS).toEqual(["wav", "mp3", "mpa", "m4a", "aac"]);
    for (const extension of AUDIO_IMPORT_EXTENSIONS) {
      expect(AUDIO_MIME[extension]).toMatch(/^audio\//);
    }
  });

  it("types a file by its extension, case-insensitively, defaulting to mpeg", () => {
    expect(audioMimeFor("take.WAV")).toBe("audio/wav");
    expect(audioMimeFor("/tmp/voice.m4a")).toBe("audio/mp4");
    expect(audioMimeFor("mystery.ogg")).toBe("audio/mpeg");
    expect(audioMimeFor("noextension")).toBe("audio/mpeg");
  });

  it("calls a recording long past twelve megabytes", () => {
    expect(isLongAudio(12 * 1024 * 1024)).toBe(false);
    expect(isLongAudio(12 * 1024 * 1024 + 1)).toBe(true);
  });
});
