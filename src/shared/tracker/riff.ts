/**
 * Walking a RIFF container.
 *
 * DSM is the only tracker format in this family built on RIFF, but the walking
 * is generic and worth having apart from the format that needs it — the reader
 * then contains only DSM's own decisions.
 *
 * A chunk whose declared length runs past the end of the file stops the walk
 * rather than throwing: a truncated module should yield whatever was actually
 * complete, and the reader above decides whether that is enough to be a module.
 */

export type RiffChunk = {
  id: string;
  /** Offset of the chunk's *payload*, so a caller never has to remember to add 8. */
  start: number;
  length: number;
};

const HEADER_BYTES = 12;

function fourCC(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

export function readRiffChunks(bytes: Uint8Array, form: string): RiffChunk[] {
  if (bytes.length < HEADER_BYTES || fourCC(bytes, 0) !== 'RIFF') {
    throw new Error('Not a RIFF file');
  }
  const actual = fourCC(bytes, 8);
  if (actual !== form) {
    throw new Error(`Not a ${form} file: RIFF form is "${actual}"`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: RiffChunk[] = [];
  let at = HEADER_BYTES;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at + 4, true);
    if (at + 8 + length > bytes.length) break;
    chunks.push({ id: fourCC(bytes, at), start: at + 8, length });
    at += 8 + length;
  }
  return chunks;
}
