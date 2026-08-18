/**
 * A hand-built IT file, for testing the reader against known bytes.
 *
 * Deliberately able to produce the shapes that make IT hard: a cell that
 * *replays* a channel's remembered value without consuming bytes, a cell that
 * reuses the channel's remembered *mask* without one, per-pattern row counts,
 * and an empty pattern. A builder that could only emit fully-specified cells
 * would agree with a reader that ignored the replay bits entirely — which is
 * exactly the bug this format invites.
 */

export type ItCellSpec = {
  /** 0-119 real note, 255 note off, 254 note cut. */
  note?: number;
  instrument?: number;
  volume?: number;
  command?: number;
  param?: number;
  /** Emit replay bits (16/32/64/128) for these fields; no bytes are written. */
  replay?: Array<'note' | 'instrument' | 'volume' | 'command'>;
  /** Emit the channel byte with bit 7 clear, reusing the channel's last mask. */
  reuseMask?: boolean;
};

export type ItPatternSpec = {
  rows: number;
  /** `cells[row][channel]`; missing entries emit nothing for that channel. */
  cells?: Array<Array<ItCellSpec | undefined>>;
  /** Write offset 0 for this pattern — an empty pattern. */
  empty?: boolean;
};

export type ItOptions = {
  title?: string;
  /** 0x0888 makes it an MPTM; anything else is an IT. */
  cmwt?: number;
  order?: number[];
  patterns?: ItPatternSpec[];
  instruments?: string[];
  samples?: string[];
  speed?: number;
  tempo?: number;
};

const ORDERS_AT = 192;
const INSTRUMENT_BYTES = 64;
const SAMPLE_BYTES = 48;

function ascii(out: Uint8Array, at: number, text: string, length: number): void {
  for (let i = 0; i < length; i += 1) out[at + i] = i < text.length ? text.charCodeAt(i) : 0;
}

function packPattern(spec: ItPatternSpec): Uint8Array {
  const body: number[] = [];
  for (let row = 0; row < spec.rows; row += 1) {
    const cells = spec.cells?.[row] ?? [];
    for (let ch = 0; ch < cells.length; ch += 1) {
      const cell = cells[ch];
      if (!cell) continue;
      const channelByte = (ch + 1) & 63;
      if (cell.reuseMask) {
        // Bit 7 clear: the reader must reuse this channel's remembered mask.
        body.push(channelByte);
      } else {
        let mask = 0;
        if (cell.note !== undefined) mask |= 1;
        if (cell.instrument !== undefined) mask |= 2;
        if (cell.volume !== undefined) mask |= 4;
        if (cell.command !== undefined) mask |= 8;
        for (const field of cell.replay ?? []) {
          if (field === 'note') mask |= 16;
          if (field === 'instrument') mask |= 32;
          if (field === 'volume') mask |= 64;
          if (field === 'command') mask |= 128;
        }
        body.push(channelByte | 128, mask);
      }
      // Value bytes follow in field order, and only for the read bits.
      if (cell.note !== undefined) body.push(cell.note);
      if (cell.instrument !== undefined) body.push(cell.instrument);
      if (cell.volume !== undefined) body.push(cell.volume);
      if (cell.command !== undefined) body.push(cell.command, cell.param ?? 0);
    }
    body.push(0); // end of row
  }
  return new Uint8Array(body);
}

export function buildIt(opts: ItOptions = {}): ArrayBuffer {
  const order = opts.order ?? [0];
  const patterns = opts.patterns ?? [{ rows: 64 }];
  const instruments = opts.instruments ?? ['Lead'];
  const samples = opts.samples ?? [];

  const packed = patterns.map((p) => (p.empty ? null : packPattern(p)));

  const headerSize =
    ORDERS_AT + order.length + (instruments.length + samples.length + patterns.length) * 4;
  const instrumentTotal = instruments.length * INSTRUMENT_BYTES;
  const sampleTotal = samples.length * SAMPLE_BYTES;
  const patternTotal = packed.reduce((n, p) => n + (p ? p.length + 8 : 0), 0);

  const out = new Uint8Array(headerSize + instrumentTotal + sampleTotal + patternTotal);
  const view = new DataView(out.buffer);

  ascii(out, 0, 'IMPM', 4);
  ascii(out, 4, opts.title ?? 'Fixture', 26);
  view.setUint16(32, order.length, true);
  view.setUint16(34, instruments.length, true);
  view.setUint16(36, samples.length, true);
  view.setUint16(38, patterns.length, true);
  view.setUint16(40, 0x0214, true); // Cwtv
  view.setUint16(42, opts.cmwt ?? 0x0214, true);
  view.setUint16(44, 0x0d, true); // Flags: stereo + use instruments
  out[50] = opts.speed ?? 6;
  out[51] = opts.tempo ?? 125;
  order.forEach((value, i) => {
    out[ORDERS_AT + i] = value;
  });

  const insTableAt = ORDERS_AT + order.length;
  const smpTableAt = insTableAt + instruments.length * 4;
  const patTableAt = smpTableAt + samples.length * 4;

  let at = headerSize;
  instruments.forEach((name, i) => {
    view.setUint32(insTableAt + i * 4, at, true);
    ascii(out, at, 'IMPI', 4);
    ascii(out, at + 32, name, 26);
    at += INSTRUMENT_BYTES;
  });
  samples.forEach((name, i) => {
    view.setUint32(smpTableAt + i * 4, at, true);
    ascii(out, at, 'IMPS', 4);
    ascii(out, at + 20, name, 26);
    at += SAMPLE_BYTES;
  });
  packed.forEach((data, i) => {
    if (!data) {
      view.setUint32(patTableAt + i * 4, 0, true); // an empty pattern
      return;
    }
    view.setUint32(patTableAt + i * 4, at, true);
    view.setUint16(at, data.length, true);
    view.setUint16(at + 2, patterns[i].rows, true);
    out.set(data, at + 8);
    at += data.length + 8;
  });

  return out.buffer;
}
