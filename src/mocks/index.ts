/**
 * Test doubles for every platform service.
 *
 * Shipped from the package rather than duplicated in each consumer, so
 * music_lib's and music_app's tests exercise the same fakes this package's own
 * contract suite does.
 */
import { createUnsupportedMidiInput } from "../shared/midi/unsupported-midi-input.js";
import type { FileExporter } from "@sudobility/music_types";
import { createMockAudioCodec } from "./audio-codec.js";
import { MockXmlParser } from "./xml.mock.js";
import { createScoreFiles } from "../shared/score-files.js";
import type { MusicIo } from "../shared/types.js";

/** Records saves instead of touching a filesystem or a download. */
export class MockFileExporter implements FileExporter {
  readonly saved: Array<{
    name: string;
    mimeType: string;
    data: Uint8Array | string;
  }> = [];

  async save(
    name: string,
    data: Uint8Array | string,
    mimeType: string,
  ): Promise<void> {
    this.saved.push({ name, data, mimeType });
  }
}

export { MockXmlParser };
export type { MusicIo };
// Platform-free, and identical on every entry: what a recording import offers.
export * from "../shared/audio-import.js";

export function createMusicIo(): MusicIo {
  const xmlParser = new MockXmlParser();
  const audioCodec = createMockAudioCodec();
  const fileExporter = new MockFileExporter();
  return {
    xmlParser,
    audioCodec,
    fileExporter,
    midiInput: createUnsupportedMidiInput(),
    // The open/save layer, built from the three capabilities above — see
    // `shared/score-files.ts` for why it lives on this bundle at all.
    ...createScoreFiles({ xmlParser, audioCodec, fileExporter }),
  };
}
