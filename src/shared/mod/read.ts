/**
 * Reading a ProTracker module into plain data.
 *
 * Deliberately stops at "what the file says" — no musical interpretation here,
 * so the byte handling can be tested against a hand-built buffer with no score
 * model in the way.
 */
/**
 * Reading a ProTracker module into plain data.
 *
 * Deliberately stops at "what the file says" — no musical interpretation here,
 * so the byte handling can be tested against a hand-built buffer without any
 * score model in the way.
 */
export type ModSample = { index: number; name: string };
export type ModCell = { sample: number; period: number; effect: number; param: number };
export type ModFile = {
  title: string;
  channels: number;
  samples: ModSample[];
  order: number[];
  patterns: ModCell[][][];
};

const HEADER_BYTES = 1084;
const ROWS_PER_PATTERN = 64;

/** Channel count per magic. `M.K.`/`M!K!` are the ubiquitous 4-channel forms. */
const MAGIC_CHANNELS: Record<string, number> = {
  'M.K.': 4,
  'M!K!': 4,
  FLT4: 4,
  '4CHN': 4,
  '6CHN': 6,
  '8CHN': 8,
  CD81: 8,
  OKTA: 8,
};

function ascii(bytes: Uint8Array, at: number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    const c = bytes[at + i];
    if (c === 0) break;
    // Sample names routinely carry decorative high-bit bytes; keep it printable.
    if (c >= 32 && c < 127) out += String.fromCharCode(c);
  }
  return out.trim();
}

export function readMod(buffer: ArrayBuffer): ModFile {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < HEADER_BYTES) throw new Error('Not a ProTracker module: file is too short');

  const magic = ascii(bytes, 1080, 4);
  const channels = MAGIC_CHANNELS[magic];
  if (!channels) throw new Error(`Not a ProTracker module: unrecognised signature "${magic}"`);

  const samples: ModSample[] = [];
  for (let i = 0; i < 31; i += 1) {
    samples.push({ index: i + 1, name: ascii(bytes, 20 + i * 30, 22) });
  }

  const songLength = Math.min(bytes[950], 128);
  const order: number[] = [];
  for (let i = 0; i < songLength; i += 1) order.push(bytes[952 + i]);

  // Patterns are not counted in the header; the highest order entry implies it.
  const patternCount = order.length === 0 ? 0 : Math.max(...order) + 1;
  const patterns: ModCell[][][] = [];
  for (let p = 0; p < patternCount; p += 1) {
    const rows: ModCell[][] = [];
    for (let row = 0; row < ROWS_PER_PATTERN; row += 1) {
      const cells: ModCell[] = [];
      for (let ch = 0; ch < channels; ch += 1) {
        const at = HEADER_BYTES + (p * ROWS_PER_PATTERN * channels + row * channels + ch) * 4;
        const b0 = bytes[at] ?? 0;
        const b1 = bytes[at + 1] ?? 0;
        const b2 = bytes[at + 2] ?? 0;
        const b3 = bytes[at + 3] ?? 0;
        cells.push({
          // The sample number spans both bytes' high nibbles — the classic
          // place this parser goes wrong for samples above 15.
          sample: (b0 & 0xf0) | (b2 >> 4),
          period: ((b0 & 0x0f) << 8) | b1,
          effect: b2 & 0x0f,
          param: b3,
        });
      }
      rows.push(cells);
    }
    patterns.push(rows);
  }

  return { title: ascii(bytes, 0, 20), channels, samples, order, patterns };
}
