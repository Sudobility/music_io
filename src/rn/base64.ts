/**
 * Base64, both directions, for React Native.
 *
 * Written out rather than reached for because Hermes guarantees neither `btoa`
 * nor Node's `Buffer`, and the two places that need it need opposite
 * directions: `file/file.rn.ts` encodes bytes to hand `react-native-fs` a
 * base64 string, and `playback/pack-library.ts` decodes the base64 mp3 data
 * URIs inside a FluidR3 sample pack.
 *
 * One module rather than a copy each, so the alphabet is defined once and the
 * pair can be round-tripped against each other — which is a stronger check than
 * either direction gets alone, since a matching error in both would still
 * survive testing them separately.
 *
 * **Both are hot enough to be worth the shape they are in.** A sample pack is
 * ~2.7MB of base64 decoded on the way into playback, per instrument, and an
 * audio export is tens of megabytes encoded on the way out — on a phone, with
 * no JIT. The obvious implementations of each were measured at 77ms and 580ms
 * for those sizes on a laptop; these are 9ms and 303ms.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Character code to sextet, -1 for anything else.
 *
 * A table rather than `ALPHABET.indexOf(char)`, which is a linear search over
 * 64 characters *per character decoded* — 8.5x the total cost on a pack-sized
 * input, and worse under an interpreter than under V8.
 */
const SEXTET = new Int8Array(256).fill(-1);
for (let i = 0; i < ALPHABET.length; i += 1) SEXTET[ALPHABET.charCodeAt(i)] = i;

/**
 * How much string to accumulate before pushing it into the chunk list.
 *
 * Growing one string four characters at a time asks the engine to keep
 * re-materialising it; joining a list of moderate pieces is roughly twice as
 * fast on an export-sized input. Large enough that the list stays short, small
 * enough that no single piece is itself expensive to grow.
 */
const ENCODE_CHUNK_CHARS = 8192;

/** Bytes to base64, padded. */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let piece = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    piece +=
      ALPHABET[a >> 2]! +
      ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)]! +
      (b === undefined ? '=' : ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]!) +
      (c === undefined ? '=' : ALPHABET[c & 0x3f]!);
    if (piece.length >= ENCODE_CHUNK_CHARS) {
      chunks.push(piece);
      piece = '';
    }
  }
  if (piece) chunks.push(piece);
  return chunks.join('');
}

/**
 * Base64 to bytes. Anything outside the alphabet — padding, newlines a data URI
 * may carry — is skipped rather than rejected.
 *
 * Skipped *inline* rather than stripped first: the obvious
 * `replace(/[^A-Za-z0-9+/]/g, '')` copies the whole multi-megabyte string
 * before any decoding starts, which on a sample pack costs as much as the
 * decode itself.
 */
export function base64ToBytes(base64: string): ArrayBuffer {
  // An upper bound — exact when there is no padding or whitespace, over by at
  // most a couple of bytes when there is. Trimmed at the end rather than
  // counted in a first pass, which would be another walk over megabytes.
  const out = new Uint8Array(((base64.length * 3) >> 2) + 3);
  let outIndex = 0;
  let accumulator = 0;
  let bits = 0;
  for (let i = 0; i < base64.length; i += 1) {
    const sextet = SEXTET[base64.charCodeAt(i) & 0xff]!;
    if (sextet < 0) continue;
    accumulator = (accumulator << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (accumulator >> bits) & 0xff;
      outIndex += 1;
    }
  }
  return out.buffer.slice(0, outIndex);
}
