/**
 * A hand-built ProTracker module, for tests.
 *
 * Exported from the package rather than copied into each consumer: the app's
 * e2e needs a real module to import, and a second builder that drifts from
 * this one is how a test starts passing against bytes the real reader would
 * reject.
 */
type CellSpec = { sample?: number; period?: number; effect?: number; param?: number };

/** Builds a minimal 4-channel ProTracker module. `rows[patternRow][channel]`. */
export function buildMod(opts: {
  title?: string;
  sampleNames?: string[];
  order?: number[];
  patterns?: CellSpec[][][];
}): ArrayBuffer {
  const patterns = opts.patterns ?? [[]];
  const bytes = new Uint8Array(1084 + patterns.length * 64 * 4 * 4);
  const write = (at: number, text: string, len: number) => {
    for (let i = 0; i < len; i += 1) bytes[at + i] = i < text.length ? text.charCodeAt(i) : 0;
  };

  write(0, opts.title ?? 'test', 20);
  (opts.sampleNames ?? []).forEach((name, i) => write(20 + i * 30, name, 22));

  const order = opts.order ?? [0];
  bytes[950] = order.length;
  order.forEach((p, i) => (bytes[952 + i] = p));
  write(1080, 'M.K.', 4);

  patterns.forEach((rows, p) => {
    const base = 1084 + p * 64 * 4 * 4;
    rows.forEach((channels, row) => {
      channels.forEach((cell, ch) => {
        const at = base + (row * 4 + ch) * 4;
        const sample = cell.sample ?? 0;
        const period = cell.period ?? 0;
        bytes[at] = (sample & 0xf0) | ((period >> 8) & 0x0f);
        bytes[at + 1] = period & 0xff;
        bytes[at + 2] = ((sample & 0x0f) << 4) | (cell.effect ?? 0);
        bytes[at + 3] = cell.param ?? 0;
      });
    });
  });

  return bytes.buffer;
}
