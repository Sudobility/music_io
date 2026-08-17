/**
 * A hand-built DSM file, for testing the reader against known bytes.
 *
 * Offsets here mirror the ones measured from a real module (see `dsm.ts`); if
 * the reader and this builder ever drift apart they will agree with each other
 * and disagree with reality, so the acceptance test against a real file is what
 * keeps them honest.
 */

export type DsmCellSpec = {
  channel: number;
  note?: number;
  instrument?: number;
  volume?: number;
  effect?: number;
  param?: number;
};

export type DsmOptions = {
  title?: string;
  channels?: number;
  instrumentNames?: string[];
  order?: number[];
  /** `patterns[p][row]` — a list of events for that row. */
  patterns?: DsmCellSpec[][][];
  initSpeed?: number;
  initBPM?: number;
};

function ascii(out: Uint8Array, at: number, text: string, length: number): void {
  for (let i = 0; i < length; i += 1) out[at + i] = i < text.length ? text.charCodeAt(i) : 0;
}

/** One packed pattern payload: a uint16 self-length, then rows terminated by a zero byte. */
function packPattern(rows: DsmCellSpec[][]): Uint8Array {
  const body: number[] = [];
  for (let row = 0; row < 64; row += 1) {
    for (const cell of rows[row] ?? []) {
      let flag = cell.channel & 0x0f;
      if (cell.note !== undefined) flag |= 0x80;
      if (cell.instrument !== undefined) flag |= 0x40;
      if (cell.volume !== undefined) flag |= 0x20;
      if (cell.effect !== undefined) flag |= 0x10;
      body.push(flag);
      if (cell.note !== undefined) body.push(cell.note);
      if (cell.instrument !== undefined) body.push(cell.instrument);
      if (cell.volume !== undefined) body.push(cell.volume);
      if (cell.effect !== undefined) body.push(cell.effect, cell.param ?? 0);
    }
    body.push(0); // end of row
  }
  const out = new Uint8Array(2 + body.length);
  new DataView(out.buffer).setUint16(0, out.length, true);
  out.set(body, 2);
  return out;
}

export function buildDsm(opts: DsmOptions = {}): ArrayBuffer {
  const channels = opts.channels ?? 4;
  const names = opts.instrumentNames ?? [];
  const order = opts.order ?? [0];
  const patterns = opts.patterns ?? [[]];

  const song = new Uint8Array(192);
  const songView = new DataView(song.buffer);
  ascii(song, 0, opts.title ?? 'Fixture', 28);
  songView.setUint16(36, order.length, true);
  songView.setUint16(38, names.length, true);
  songView.setUint16(40, patterns.length, true);
  songView.setUint16(42, channels, true);
  song[44] = 64;
  song[45] = 192;
  song[46] = opts.initSpeed ?? 6;
  song[47] = opts.initBPM ?? 125;
  order.forEach((value, i) => {
    song[64 + i] = value;
  });

  const instruments = names.map((name) => {
    const chunk = new Uint8Array(64); // header only; no sample data
    new DataView(chunk.buffer).setUint32(16, 0, true); // length 0
    ascii(chunk, 36, name, 28);
    return chunk;
  });

  const packed = patterns.map(packPattern);
  const parts: Array<[string, Uint8Array]> = [
    ['SONG', song],
    ...packed.map((p): [string, Uint8Array] => ['PATT', p]),
    ...instruments.map((i): [string, Uint8Array] => ['INST', i]),
  ];

  const body = parts.reduce((n, [, data]) => n + 8 + data.length, 0);
  const out = new Uint8Array(12 + body);
  const view = new DataView(out.buffer);
  ascii(out, 0, 'RIFF', 4);
  view.setUint32(4, 4 + body, true);
  ascii(out, 8, 'DSMF', 4);
  let at = 12;
  for (const [id, data] of parts) {
    ascii(out, at, id, 4);
    view.setUint32(at + 4, data.length, true);
    out.set(data, at + 8);
    at += 8 + data.length;
  }
  return out.buffer;
}
