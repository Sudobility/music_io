/**
 * A `MidiInput` for a platform that has none.
 *
 * Reports `isSupported()` false and lists nothing, so an app hides the feature
 * rather than offering a device picker that can never fill. Subscribing is
 * allowed and simply never delivers — a caller that wires it up
 * unconditionally is not a bug, it just gets silence.
 *
 * React Native uses this until a native module exists; the mocks use it so a
 * test never touches a real port.
 */
import type { MidiInput, MidiInputDevice } from '@sudobility/music_types';

export function createUnsupportedMidiInput(): MidiInput {
  return {
    isSupported: () => false,
    listDevices: async (): Promise<MidiInputDevice[]> => [],
    subscribe: () => () => undefined,
  };
}
