/**
 * MIDI input over the Web MIDI API.
 *
 * Access is requested lazily, on the first `listDevices`, because
 * `requestMIDIAccess` shows a permission prompt in some browsers and asking on
 * page load would prompt everyone whether or not they own a keyboard.
 *
 * `sysex: false` deliberately: this only needs note messages, and asking for
 * system-exclusive access turns a quiet permission into a scary one.
 */
import type {
  MidiInput,
  MidiInputDevice,
  MidiInputEvent,
  MidiInputHandler,
} from '@sudobility/music_types';

/** Status byte high nibbles. The low nibble is the channel, which we ignore. */
const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;

type MIDIAccessLike = {
  inputs: Map<string, MIDIInputLike>;
};

type MIDIInputLike = {
  id: string;
  name: string | null;
  onmidimessage: ((event: { data: Uint8Array | null }) => void) | null;
};

/**
 * Decodes one MIDI message, or `null` for anything that is not a note.
 *
 * A note-on at velocity 0 is reported as an off: many keyboards send that
 * instead of a real note-off, and a caller that took it literally would leave
 * the note sounding forever.
 */
export function decodeMidiMessage(data: Uint8Array | null): MidiInputEvent | null {
  if (!data || data.length < 3) return null;
  const status = data[0] & 0xf0;
  const note = data[1];
  const velocity = data[2];

  if (status === NOTE_ON) {
    return velocity > 0 ? { type: 'on', note, velocity } : { type: 'off', note };
  }
  if (status === NOTE_OFF) return { type: 'off', note };
  return null;
}

export function createWebMidiInput(): MidiInput {
  let access: MIDIAccessLike | null = null;
  /** Every live subscription, so a device attached later can be wired to them. */
  const handlers = new Set<{ handler: MidiInputHandler; deviceId?: string }>();

  const supported = (): boolean =>
    typeof navigator !== 'undefined' &&
    typeof (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess === 'function';

  /** Points every attached port at the fan-out below. */
  const wire = (): void => {
    if (!access) return;
    for (const [, input] of access.inputs) {
      input.onmidimessage = (message) => {
        const event = decodeMidiMessage(message.data);
        if (!event) return;
        for (const entry of handlers) {
          if (entry.deviceId && entry.deviceId !== input.id) continue;
          entry.handler(event);
        }
      };
    }
  };

  const ensureAccess = async (): Promise<MIDIAccessLike> => {
    if (access) return access;
    const request = (
      navigator as unknown as {
        requestMIDIAccess: (options: { sysex: boolean }) => Promise<MIDIAccessLike>;
      }
    ).requestMIDIAccess;
    access = await request.call(navigator, { sysex: false });
    wire();
    return access;
  };

  return {
    isSupported: supported,

    async listDevices(): Promise<MidiInputDevice[]> {
      if (!supported()) return [];
      const midi = await ensureAccess();
      return [...midi.inputs.values()].map((input) => ({
        id: input.id,
        name: input.name ?? 'MIDI device',
      }));
    },

    subscribe(handler: MidiInputHandler, deviceId?: string): () => void {
      const entry = { handler, deviceId };
      handlers.add(entry);
      // Access may not have been requested yet — subscribing before listing is
      // legitimate, and the ports wire themselves up when it arrives.
      if (supported()) void ensureAccess().catch(() => undefined);
      return () => {
        handlers.delete(entry);
      };
    },
  };
}
