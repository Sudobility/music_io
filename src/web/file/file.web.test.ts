// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { WebFileExporter } from './file.web.js';

describe('WebFileExporter', () => {
  it('downloads through an object URL and releases it again', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await new WebFileExporter().save('score.mid', new Uint8Array([1, 2]), 'audio/midi');

    expect(click).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // Leaking the object URL would pin the blob in memory for the page's life.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
    // The anchor is a means, not a side effect: it must not survive the call.
    expect(document.querySelector('a')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('accepts text as well as bytes', async () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:y', revokeObjectURL: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await expect(new WebFileExporter().save('s.xml', '<score/>', 'application/xml')).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
