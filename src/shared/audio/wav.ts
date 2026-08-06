/**
 * WAV encoding — a 44-byte RIFF header and 16-bit PCM samples.
 *
 * Platform-free, so both the web codec and the mocks use the same one rather
 * than growing two headers that can disagree.
 */
import type { DecodedAudio } from '@sudobility/music_types';

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeWav({ samples, sampleRate }: DecodedAudio): ArrayBuffer {
  const bytes = samples.length * 2;
  const out = new ArrayBuffer(44 + bytes);
  const view = new DataView(out);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, bytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    // Clamped before scaling: a sample slightly over 1.0 would wrap to a loud
    // click rather than clipping quietly.
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped * 0x7fff, true);
  }
  return out;
}

/** Decodes what `encodeWav` produced. Used by the mocks, where there is no Web Audio. */
export function decodeWav(bytes: ArrayBuffer): DecodedAudio {
  const view = new DataView(bytes);
  const sampleRate = view.getUint32(24, true);
  const dataBytes = view.getUint32(40, true);
  const samples = new Float32Array(dataBytes / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(44 + i * 2, true) / 0x7fff;
  }
  return { samples, sampleRate };
}
