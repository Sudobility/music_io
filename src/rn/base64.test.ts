import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './base64.js';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('bytesToBase64', () => {
  it('encodes a whole group', () => {
    expect(bytesToBase64(bytes(1, 2, 255))).toBe('AQL/');
  });

  it('pads a remainder of one byte', () => {
    expect(bytesToBase64(bytes(1))).toBe('AQ==');
  });

  it('pads a remainder of two bytes', () => {
    expect(bytesToBase64(bytes(1, 2))).toBe('AQI=');
  });

  it('matches Buffer across every byte value', () => {
    // Against a reference implementation rather than hand-computed vectors:
    // the failures worth catching are in the bit-shifting, and those show up on
    // particular values rather than on lengths.
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(bytesToBase64(all)).toBe(Buffer.from(all).toString('base64'));
  });

  it('encodes nothing as nothing', () => {
    expect(bytesToBase64(bytes())).toBe('');
  });
});

describe('base64ToBytes', () => {
  it('decodes without atob or Buffer, neither of which Hermes guarantees', () => {
    expect([...new Uint8Array(base64ToBytes('SGVsbG8='))]).toEqual([72, 101, 108, 108, 111]);
  });

  it('ignores characters a data URI may carry', () => {
    // Sample packs are one long line, but a wrapped or padded body must decode
    // to the same mp3 rather than to noise.
    expect([...new Uint8Array(base64ToBytes('AQL/'))]).toEqual([
      ...new Uint8Array(base64ToBytes('AQ\nL/\r')),
    ]);
  });
});

describe('the pair', () => {
  it('round-trips every length up to a full group and beyond', () => {
    // The check neither direction gets alone. Testing them separately would let
    // a matching error in both — a wrong alphabet, say — pass twice: encode
    // wrong, decode wrong the same way, and the bytes still come back.
    // Comparing against Buffer above is what stops that; this is what stops the
    // padding cases diverging.
    for (let length = 0; length <= 10; length += 1) {
      const original = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
      const round = new Uint8Array(base64ToBytes(bytesToBase64(original)));
      expect([...round], `length ${length}`).toEqual([...original]);
    }
  });

  it('round-trips bytes that exercise every bit position', () => {
    const original = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect([...new Uint8Array(base64ToBytes(bytesToBase64(original)))]).toEqual([...original]);
  });
});
