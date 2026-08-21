import { describe, expect, it, vi } from 'vitest';
import { createWebMidiInput, decodeMidiMessage } from './web-midi-input.js';

describe('decodeMidiMessage', () => {
  it('reads a note-on', () => {
    // 0x90 = note on, channel 1. The channel is deliberately ignored.
    expect(decodeMidiMessage(new Uint8Array([0x90, 60, 100]))).toEqual({
      type: 'on',
      note: 60,
      velocity: 100,
    });
    expect(decodeMidiMessage(new Uint8Array([0x93, 62, 64]))).toEqual({
      type: 'on',
      note: 62,
      velocity: 64,
    });
  });

  it('reads a note-off', () => {
    expect(decodeMidiMessage(new Uint8Array([0x80, 60, 0]))).toEqual({ type: 'off', note: 60 });
  });

  it('treats a note-on at velocity zero as a note-off', () => {
    // Many keyboards send this instead of a real note-off. Taken literally it
    // would leave the note sounding forever.
    expect(decodeMidiMessage(new Uint8Array([0x90, 60, 0]))).toEqual({ type: 'off', note: 60 });
  });

  it('ignores everything that is not a note', () => {
    expect(decodeMidiMessage(new Uint8Array([0xb0, 7, 100]))).toBeNull(); // control change
    expect(decodeMidiMessage(new Uint8Array([0xe0, 0, 64]))).toBeNull(); // pitch bend
    expect(decodeMidiMessage(new Uint8Array([0x90, 60]))).toBeNull(); // truncated
    expect(decodeMidiMessage(null)).toBeNull();
  });
});

describe('createWebMidiInput', () => {
  it('reports unsupported when the browser has no Web MIDI', () => {
    const input = createWebMidiInput();
    expect(input.isSupported()).toBe(false);
  });

  it('lists nothing rather than throwing where it is unsupported', async () => {
    await expect(createWebMidiInput().listDevices()).resolves.toEqual([]);
  });

  it('delivers note events from an attached port to a subscriber', async () => {
    const port = { id: 'p1', name: 'Keystation', onmidimessage: null as unknown };
    const access = { inputs: new Map([['p1', port]]) };
    vi.stubGlobal('navigator', { requestMIDIAccess: vi.fn(async () => access) });

    const input = createWebMidiInput();
    const heard: unknown[] = [];
    input.subscribe((event) => heard.push(event));
    const devices = await input.listDevices();

    (port.onmidimessage as (e: { data: Uint8Array }) => void)({
      data: new Uint8Array([0x90, 64, 90]),
    });

    expect(devices).toEqual([{ id: 'p1', name: 'Keystation' }]);
    expect(heard).toEqual([{ type: 'on', note: 64, velocity: 90 }]);
    vi.unstubAllGlobals();
  });

  it('stops delivering once unsubscribed', async () => {
    const port = { id: 'p1', name: null as string | null, onmidimessage: null as unknown };
    const access = { inputs: new Map([['p1', port]]) };
    vi.stubGlobal('navigator', { requestMIDIAccess: vi.fn(async () => access) });

    const input = createWebMidiInput();
    const heard: unknown[] = [];
    const stop = input.subscribe((event) => heard.push(event));
    await input.listDevices();
    stop();

    (port.onmidimessage as (e: { data: Uint8Array }) => void)({
      data: new Uint8Array([0x90, 64, 90]),
    });

    expect(heard).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('names an unnamed port rather than showing nothing', async () => {
    const access = { inputs: new Map([['p1', { id: 'p1', name: null, onmidimessage: null }]]) };
    vi.stubGlobal('navigator', { requestMIDIAccess: vi.fn(async () => access) });

    expect(await createWebMidiInput().listDevices()).toEqual([
      { id: 'p1', name: 'MIDI device' },
    ]);
    vi.unstubAllGlobals();
  });
});
