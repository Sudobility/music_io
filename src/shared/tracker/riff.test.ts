import { describe, expect, it } from 'vitest';
import { readRiffChunks } from './riff.js';

/** A RIFF file of `[id, payloadLength]` chunks, payloads filled with the chunk index. */
function riff(form: string, chunks: Array<[string, number]>): Uint8Array {
  const body = chunks.reduce((n, [, len]) => n + 8 + len, 0);
  const out = new Uint8Array(12 + body);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < 4; i += 1) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 4 + body, true);
  ascii(8, form);
  let at = 12;
  chunks.forEach(([id, len], index) => {
    ascii(at, id);
    view.setUint32(at + 4, len, true);
    out.fill(index + 1, at + 8, at + 8 + len);
    at += 8 + len;
  });
  return out;
}

describe('readRiffChunks', () => {
  it('lists every chunk with its payload offset and length', () => {
    const chunks = readRiffChunks(riff('DSMF', [['SONG', 4], ['PATT', 8]]), 'DSMF');
    expect(chunks).toEqual([
      { id: 'SONG', start: 20, length: 4 },
      { id: 'PATT', start: 32, length: 8 },
    ]);
  });

  it('gives a payload offset that points at the payload, not the header', () => {
    const bytes = riff('DSMF', [['SONG', 4]]);
    const [song] = readRiffChunks(bytes, 'DSMF');
    // The builder fills the first chunk's payload with 1s.
    expect(bytes[song.start]).toBe(1);
  });

  it('rejects a file that is not RIFF at all', () => {
    expect(() => readRiffChunks(new Uint8Array(64), 'DSMF')).toThrow(/riff/i);
  });

  it('rejects the right RIFF of the wrong form', () => {
    expect(() => readRiffChunks(riff('WAVE', [['fmt ', 4]]), 'DSMF')).toThrow(/DSMF/);
  });

  it('stops at a chunk whose length runs past the end rather than reading rubbish', () => {
    const bytes = riff('DSMF', [['SONG', 4]]);
    new DataView(bytes.buffer).setUint32(16, 9999, true);
    expect(readRiffChunks(bytes, 'DSMF')).toEqual([]);
  });

  it('handles a file with no chunks', () => {
    expect(readRiffChunks(riff('DSMF', []), 'DSMF')).toEqual([]);
  });
});
