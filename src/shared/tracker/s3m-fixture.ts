/**
 * A hand-built S3M file, for testing the reader against known bytes.
 *
 * Parapointers make this fiddlier than the other fixtures: the header holds
 * offsets to the instrument and pattern blocks divided by sixteen, so the
 * builder has to lay the file out and then go back and fill them in. Every
 * block is padded to a 16-byte boundary for that reason.
 *
 * Offsets mirror those measured from two real modules; the acceptance test
 * against those files is what stops this and the reader agreeing with each
 * other while both being wrong.
 */

export type S3mCellSpec = {
  channel: number;
  /** `(octave << 4) | note`, or 255 for empty, 254 for a cut. */
  note?: number;
  instrument?: number;
  volume?: number;
  command?: number;
  info?: number;
};

export type S3mOptions = {
  title?: string;
  /** How many entries of `channelSettings` are marked enabled. */
  channels?: number;
  instrumentNames?: string[];
  order?: number[];
  /** `patterns[p][row]` — a list of events for that row. */
  patterns?: S3mCellSpec[][][];
  initialSpeed?: number;
  initialTempo?: number;
  /** Drop the final row terminator, as a real writer does. See the plan's Quirk 1. */
  truncateLastRow?: boolean;
};

const PARA = 16;

function ascii(out: Uint8Array, at: number, text: string, length: number): void {
  for (let i = 0; i < length; i += 1) out[at + i] = i < text.length ? text.charCodeAt(i) : 0;
}

function packPattern(rows: S3mCellSpec[][], truncate: boolean): Uint8Array {
  const body: number[] = [];
  for (let row = 0; row < 64; row += 1) {
    for (const cell of rows[row] ?? []) {
      let flag = cell.channel & 31;
      if (cell.note !== undefined) flag |= 32;
      if (cell.volume !== undefined) flag |= 64;
      if (cell.command !== undefined) flag |= 128;
      body.push(flag);
      // Note and instrument travel together under one flag bit.
      if (cell.note !== undefined) body.push(cell.note, cell.instrument ?? 0);
      if (cell.volume !== undefined) body.push(cell.volume);
      if (cell.command !== undefined) body.push(cell.command, cell.info ?? 0);
    }
    const last = row === 63;
    if (!(last && truncate)) body.push(0);
  }
  const out = new Uint8Array(2 + body.length);
  new DataView(out.buffer).setUint16(0, out.length, true);
  out.set(body, 2);
  return out;
}

function instrumentChunk(name: string, empty: boolean): Uint8Array {
  const out = new Uint8Array(80);
  out[0] = empty ? 0 : 1;
  if (!empty) {
    new DataView(out.buffer).setUint32(16, 64, true); // a nominal sample length
    ascii(out, 48, name, 28);
    ascii(out, 76, 'SCRS', 4);
  }
  return out;
}

export function buildS3m(opts: S3mOptions = {}): ArrayBuffer {
  const channels = opts.channels ?? 4;
  const names = opts.instrumentNames ?? ['Lead'];
  const order = opts.order ?? [0];
  const patterns = opts.patterns ?? [[]];

  const packed = patterns.map((p) => packPattern(p, opts.truncateLastRow ?? false));
  const instruments = names.map((n) => instrumentChunk(n, n.length === 0));

  // Header, orders, then the two pointer tables — then everything padded to
  // 16-byte boundaries so a parapointer can address it.
  const tableAt = 96 + order.length;
  const bodyAt = Math.ceil((tableAt + instruments.length * 2 + packed.length * 2) / PARA) * PARA;

  const blocks: Array<{ data: Uint8Array; at: number }> = [];
  let at = bodyAt;
  for (const data of [...instruments, ...packed]) {
    blocks.push({ data, at });
    at = Math.ceil((at + data.length) / PARA) * PARA;
  }

  const out = new Uint8Array(at);
  const view = new DataView(out.buffer);
  ascii(out, 0, opts.title ?? 'Fixture', 28);
  out[28] = 0x1a;
  out[29] = 0x10;
  view.setUint16(32, order.length, true);
  view.setUint16(34, instruments.length, true);
  view.setUint16(36, packed.length, true);
  view.setUint16(42, 2, true);
  ascii(out, 44, 'SCRM', 4);
  out[48] = 64;
  out[49] = opts.initialSpeed ?? 6;
  out[50] = opts.initialTempo ?? 125;
  out[51] = 176;
  out[53] = 0xfc;
  // 255 marks a channel unused; anything below 16 is an enabled PCM channel.
  out.fill(255, 64, 96);
  for (let i = 0; i < channels; i += 1) out[64 + i] = i;

  order.forEach((value, i) => {
    out[96 + i] = value;
  });
  blocks.forEach(({ data, at: blockAt }, i) => {
    out.set(data, blockAt);
    view.setUint16(tableAt + i * 2, blockAt / PARA, true);
  });

  return out.buffer;
}
