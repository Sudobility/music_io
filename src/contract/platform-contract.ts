import { describe, expect, it } from 'vitest';
import type { MusicIo } from '../shared/types.js';
// The package's own hand-built module, so this cannot drift from the reader.

/**
 * What a platform promises about the two capabilities that are not universal.
 *
 * Stated per entry rather than inferred, because "this platform cannot do
 * audio" is a design decision and should read like one at the call site. Every
 * other service — XML, MIDI, MOD, WAV, file export — is required of everyone
 * and needs no flag.
 */
/**
 * The one suite every platform implementation is held to.
 *
 * Without it, web, React Native and the mocks would each be tested differently
 * and could drift apart while all three stayed green — which is exactly the
 * failure a platform abstraction is supposed to prevent.
 */
export function runPlatformContract(
  name: string,
  createIo: () => MusicIo,
): void {
  describe(`${name}: platform contract`, () => {
    it('provides every service', () => {
      const io = createIo();
      expect(io.xmlParser).toBeDefined();
      expect(io.fileExporter).toBeDefined();
      expect(io.audioCodec).toBeDefined();
    });

    it('parses XML and exposes the root element', () => {
      const root = createIo().xmlParser.parse(
        '<score-partwise version="4.0"><part id="P1"/></score-partwise>',
      );
      expect(root.tagName).toBe('score-partwise');
      expect(root.getAttribute('version')).toBe('4.0');
      expect(Array.from(root.children)[0].tagName).toBe('part');
    });

    /**
     * `textContent` reaches descendants, not just the element's own text.
     *
     * Deliberately *not* claiming to match DOM exactly. It does for the nesting
     * MusicXML actually uses — an element whose text lives in leaves — which is
     * what this pins. It does not for mixed content: given `<a>x<b>y</b>z</a>`
     * the web parser returns "xyz" and the other two "xzy", because
     * `fast-xml-parser` collapses an element's text nodes into one `#text` key
     * and discards their position relative to child elements. Document order is
     * not recoverable from that, so the divergence is the parser's and cannot be
     * closed here. MusicXML has no mixed content, so nothing depends on it.
     */
    it('reports textContent from descendant text, not only the element\'s own', () => {
      const root = createIo().xmlParser.parse(
        '<score-partwise><part><measure><note>C4</note></measure></part></score-partwise>',
      );
      const part = root.getElementsByTagName('part')[0];
      expect(part.textContent).toBe('C4');
    });

    it('rejects malformed XML rather than returning a broken root', () => {
      expect(() => createIo().xmlParser.parse('<a><b></a>')).toThrow();
    });



    it('writes a real WAV file, not a bare buffer', () => {
      const io = createIo();
      const sampleRate = 44100;
      const samples = new Float32Array(sampleRate / 10);
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
      }

      const wav = io.audioCodec.encodeWav({ samples, sampleRate });
      expect(new TextDecoder().decode(new Uint8Array(wav, 0, 4))).toBe('RIFF');
      expect(new TextDecoder().decode(new Uint8Array(wav, 8, 4))).toBe('WAVE');
      expect(wav.byteLength).toBe(44 + samples.length * 2);
    });
  });
}
