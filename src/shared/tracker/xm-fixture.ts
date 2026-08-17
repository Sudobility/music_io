/**
 * A hand-built XM file, for testing the reader against known bytes.
 *
 * Deliberately able to produce the three awkward shapes real files contain: an
 * instrument with no samples (a 33-byte header rather than 263), a pattern with
 * no packed data (blank rows, not zero rows), and a pattern that is not 64 rows
 * long. A builder that could only make the easy case would agree with a reader
 * that could only read it.
 */

export type XmCellSpec = {
  /** 1-96, where 1 is C-0. 97 is key off. Omitted for an empty cell. */
  note?: number;
  instrument?: number;
  volume?: number;
  effect?: number;
  param?: number;
  /** Write this event uncompressed — the bit-7-clear form. */
  uncompressed?: boolean;
};

export type XmPatternSpec = {
  rows: number;
  /** `cells[row][channel]`; missing entries are empty. */
  cells?: XmCellSpec[][];
  /** Emit `packedSize = 0`, meaning `rows` blank rows. */
  empty?: boolean;
};

export type XmOptions = {
  title?: string;
  channels?: number;
  order?: number[];
  patterns?: XmPatternSpec[];
  /** One entry per instrument; `samples: 0` writes the 33-byte header form. */
  instruments?: Array<{ name: string; samples?: number; sampleLengths?: number[] }>;
  defaultSpeed?: number;
  defaultBPM?: number;
};

const HEADER_SIZE = 276;
const INSTRUMENT_HEADER_WITH_SAMPLES = 263;
const INSTRUMENT_HEADER_EMPTY = 33;
const SAMPLE_HEADER_SIZE = 40;

function ascii(out: Uint8Array, at: number, text: string, length: number): void {
  for (let i = 0; i < length; i += 1) out[at + i] = i < text.length ? text.charCodeAt(i) : 0;
}

function packPattern(spec: XmPatternSpec, channels: number): Uint8Array {
  if (spec.empty) return new Uint8Array(0);
  const body: number[] = [];
  for (let row = 0; row < spec.rows; row += 1) {
    for (let ch = 0; ch < channels; ch += 1) {
      const cell = spec.cells?.[row]?.[ch];
      if (!cell) {
        // An empty cell is a mask byte with no fields selected.
        body.push(0x80);
        continue;
      }
      if (cell.uncompressed) {
        body.push(
          cell.note ?? 0,
          cell.instrument ?? 0,
          cell.volume ?? 0,
          cell.effect ?? 0,
          cell.param ?? 0,
        );
        continue;
      }
      let mask = 0x80;
      if (cell.note !== undefined) mask |= 1;
      if (cell.instrument !== undefined) mask |= 2;
      if (cell.volume !== undefined) mask |= 4;
      if (cell.effect !== undefined) mask |= 8;
      if (cell.param !== undefined) mask |= 16;
      body.push(mask);
      if (cell.note !== undefined) body.push(cell.note);
      if (cell.instrument !== undefined) body.push(cell.instrument);
      if (cell.volume !== undefined) body.push(cell.volume);
      if (cell.effect !== undefined) body.push(cell.effect);
      if (cell.param !== undefined) body.push(cell.param);
    }
  }
  return new Uint8Array(body);
}

export function buildXm(opts: XmOptions = {}): ArrayBuffer {
  const channels = opts.channels ?? 4;
  const order = opts.order ?? [0];
  const patterns = opts.patterns ?? [{ rows: 64 }];
  const instruments = opts.instruments ?? [{ name: 'Lead', samples: 1, sampleLengths: [64] }];

  const packedPatterns = patterns.map((p) => packPattern(p, channels));

  const patternBlocks = patterns.map((spec, i) => {
    const head = new Uint8Array(9);
    const view = new DataView(head.buffer);
    view.setUint32(0, 9, true);
    head[4] = 0;
    view.setUint16(5, spec.rows, true);
    view.setUint16(7, packedPatterns[i].length, true);
    return { head, data: packedPatterns[i] };
  });

  const instrumentBlocks = instruments.map((ins) => {
    const samples = ins.samples ?? 0;
    const lengths = ins.sampleLengths ?? Array.from({ length: samples }, () => 64);
    const headerSize = samples > 0 ? INSTRUMENT_HEADER_WITH_SAMPLES : INSTRUMENT_HEADER_EMPTY;
    const total = headerSize + samples * SAMPLE_HEADER_SIZE + lengths.reduce((n, l) => n + l, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, headerSize, true);
    ascii(out, 4, ins.name, 22);
    out[26] = 0;
    view.setUint16(27, samples, true);
    if (samples > 0) {
      view.setUint32(29, SAMPLE_HEADER_SIZE, true);
      lengths.forEach((length, s) => {
        view.setUint32(headerSize + s * SAMPLE_HEADER_SIZE, length, true);
      });
    }
    return out;
  });

  const bodySize =
    patternBlocks.reduce((n, p) => n + p.head.length + p.data.length, 0) +
    instrumentBlocks.reduce((n, i) => n + i.length, 0);
  const out = new Uint8Array(60 + HEADER_SIZE + bodySize);
  const view = new DataView(out.buffer);

  ascii(out, 0, 'Extended Module: ', 17);
  ascii(out, 17, opts.title ?? 'Fixture', 20);
  out[37] = 0x1a;
  ascii(out, 38, 'FastTracker v2.00   ', 20);
  view.setUint16(58, 0x0104, true);
  view.setUint32(60, HEADER_SIZE, true);
  view.setUint16(64, order.length, true);
  view.setUint16(68, channels, true);
  view.setUint16(70, patterns.length, true);
  view.setUint16(72, instruments.length, true);
  view.setUint16(76, opts.defaultSpeed ?? 6, true);
  view.setUint16(78, opts.defaultBPM ?? 125, true);
  order.forEach((value, i) => {
    out[80 + i] = value;
  });

  let at = 60 + HEADER_SIZE;
  for (const { head, data } of patternBlocks) {
    out.set(head, at);
    at += head.length;
    out.set(data, at);
    at += data.length;
  }
  for (const block of instrumentBlocks) {
    out.set(block, at);
    at += block.length;
  }
  return out.buffer;
}
