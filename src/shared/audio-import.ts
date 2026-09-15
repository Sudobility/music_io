/**
 * What a recording import accepts.
 *
 * The file goes to the server, which separates and transcribes it — nothing is
 * decoded on the device — so the rules here are about the upload: which files
 * to offer, what to call them, and when to warn that one is long.
 *
 * It is here rather than in music_types because it is about files and audio
 * formats, which is this package's job, and here rather than in `web/` or
 * `rn/` because both apps offer the same import: every entry re-exports it,
 * so `@sudobility/music_io` hands each app the same list whichever branch of
 * the export map it resolves.
 */

/** The formats offered by the file picker, which the transcriber decodes. */
export const AUDIO_IMPORT_EXTENSIONS = ["wav", "mp3", "mpa", "m4a", "aac"] as const;
export type AudioImportExtension = (typeof AUDIO_IMPORT_EXTENSIONS)[number];

/** MIME types by extension. React Native will not infer one for an upload. */
export const AUDIO_MIME: Record<AudioImportExtension, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mpa: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
};

/**
 * The MIME type for a file name or path, by its extension.
 *
 * A default rather than a refusal: the server sniffs the container anyway, and
 * refusing an unusual extension here would reject files it can read.
 */
export function audioMimeFor(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const extension = dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
  return (AUDIO_MIME as Record<string, string>)[extension] ?? "audio/mpeg";
}

/** Past this, the import says the recording is long before uploading it. */
const LONG_AUDIO_BYTES = 12 * 1024 * 1024;

/**
 * Whether a recording is long enough to warn about. A warning, not a limit:
 * trimming would mean decoding on the device, and the server enforces its own
 * maximum.
 */
export function isLongAudio(bytes: number): boolean {
  return bytes > LONG_AUDIO_BYTES;
}
