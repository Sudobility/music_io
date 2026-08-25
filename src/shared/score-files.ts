/**
 * The file layer above the codecs.
 *
 * `@sudobility/music_codecs` turns bytes into a `Score` and back; this turns
 * *files* into a `Score` and back — read bytes, call the codec, hand over a
 * score; take a score, call the codec, write the file. The app used to do that
 * pairing itself, which is why `AppLayout` grew four near-identical export
 * handlers and the MusicXML dialog constructed a service around `xmlParser`.
 *
 * Methods on the `MusicIo` bundle rather than free functions, because the save
 * half needs `fileExporter` and the MusicXML half needs `xmlParser`, and both
 * are already here.
 *
 * **`open*`/`save*`, never `import*`/`export*`.** `music_codecs` already exports
 * `importMidi`/`exportMidi`; two identically-named functions in packages the app
 * imports together is a collision that gets resolved wrongly under time
 * pressure.
 *
 * **Audio is deliberately asymmetric with the score formats.** This package
 * orchestrates a codec, which is a pure function it may call; it does not
 * orchestrate rendering, which is a live synth with platform-bound state living
 * in `@sudobility/music_player`. So `saveAudio` takes PCM the caller already
 * rendered, and this package never holds a reference to a running synth.
 */
import {
  analyzeMidi as analyzeMidiBytes,
  exportMidi,
  exportMusicXml,
  importMidi,
  importMusicXml,
  decodeTracker,
  encodeTracker,
  trackerToScore,
} from "@sudobility/music_codecs";
import type {
  MidiImportOptions,
  MidiImportResult,
  MidiSummary,
  MusicXmlImportResult,
  MusicXmlWarnings,
  TrackerModule,
} from "@sudobility/music_codecs";
import type {
  AudioCodec,
  FileExporter,
  Score,
  XmlParser,
} from "@sudobility/music_types";

/** MIME types the platform exporters hand to the OS. */
const MIME = {
  midi: "audio/midi",
  musicxml: "application/vnd.recordare.musicxml+xml",
  tracker: "application/octet-stream",
  wav: "audio/wav",
  mp3: "audio/mpeg",
} as const;

export type ScoreFiles = {
  openMidi(bytes: ArrayBuffer, options: MidiImportOptions): MidiImportResult;
  analyzeMidi(bytes: ArrayBuffer): MidiSummary;
  openTracker(bytes: ArrayBuffer): { module: TrackerModule; score: Score };
  openMusicXml(
    text: string,
    warnings: MusicXmlWarnings,
  ): Promise<MusicXmlImportResult>;

  saveMidi(score: Score, filename: string): Promise<void>;
  saveTracker(module: TrackerModule, filename: string): Promise<void>;
  saveMusicXml(score: Score, filename: string): Promise<void>;
  saveAudio(
    samples: Float32Array,
    sampleRate: number,
    format: "wav" | "mp3",
    filename: string,
  ): Promise<void>;
};

export function createScoreFiles(deps: {
  xmlParser: XmlParser;
  audioCodec: AudioCodec;
  fileExporter: FileExporter;
}): ScoreFiles {
  const { xmlParser, audioCodec, fileExporter } = deps;

  return {
    openMidi: (bytes, options) => importMidi(bytes, options),
    analyzeMidi: (bytes) => analyzeMidiBytes(bytes),

    /**
     * Both halves, because the caller needs both: the score to open, and the
     * module to name the project after (`module.title`).
     */
    openTracker: (bytes) => {
      const module = decodeTracker(bytes);
      return { module, score: trackerToScore(module) };
    },

    openMusicXml: async (text, warnings) =>
      importMusicXml(text, xmlParser, warnings),

    saveMidi: async (score, filename) => {
      await fileExporter.save(filename, exportMidi(score), MIME.midi);
    },

    /**
     * Takes a `TrackerModule`, not a `Score`, and that is deliberate.
     *
     * A tracker export is lossy in three counted ways — the row grid, the
     * channel cap, the note range — and the app shows those numbers *before*
     * writing: a clean fit costs no extra click, anything lost shows the report
     * first. A `saveTracker(score, …)` that returned the report would have to
     * write before it could report, inverting that. So the caller runs
     * `scoreToTracker` when it wants the fit, and this writes what came out.
     */
    saveTracker: async (module, filename) => {
      await fileExporter.save(
        filename,
        new Uint8Array(encodeTracker(module)),
        MIME.tracker,
      );
    },

    saveMusicXml: async (score, filename) => {
      const xml = exportMusicXml(score);
      await fileExporter.save(filename, xml, MIME.musicxml);
    },

    saveAudio: async (samples, sampleRate, format, filename) => {
      const audio = { samples, sampleRate };
      const bytes =
        format === "wav"
          ? audioCodec.encodeWav(audio)
          : audioCodec.encodeMp3(audio);
      await fileExporter.save(filename, new Uint8Array(bytes), MIME[format]);
    },
  };
}
