/**
 * Which synth instance and MIDI channel each track plays on.
 *
 * General MIDI addresses 16 channels and scores exceed that, so the worklet
 * hosts several synth instances. Two rules shape the allocation, both of them
 * facts about fluidsynth rather than preferences:
 *
 * - **Channel 9 is percussion and cannot be anything else.** The spike found
 *   that a drum track sounds there only if left completely alone: selecting a
 *   program on it silences the channel. So percussion prefers channel 9, and a
 *   pitched track may never take it.
 * - **Any channel can be made percussion** with `midiSetChannelType`. That is
 *   what lets a second drum track share an instance instead of costing a whole
 *   new 16-channel synth just to reach another channel 9.
 *
 * Instances are therefore opened only when channels genuinely run out.
 */
export type ChannelAssignment = {
  instance: number;
  channel: number;
  /**
   * True when the channel is percussion but is not channel 9, so the engine
   * must call `midiSetChannelType` on it. Channel 9 needs nothing.
   */
  needsDrumTypeSwitch: boolean;
};

export type AllocatorTrack = { id: string; isPercussion: boolean };

const CHANNELS_PER_INSTANCE = 16;
const PERCUSSION_CHANNEL = 9;

export function allocateChannels(tracks: readonly AllocatorTrack[]): {
  assignments: Map<string, ChannelAssignment>;
  instanceCount: number;
} {
  const assignments = new Map<string, ChannelAssignment>();
  /** Taken channels per instance; the array length is the instance count. */
  const taken: Array<Set<number>> = [new Set()];

  const freeChannel = (instance: number, allowNine: boolean): number | null => {
    for (let channel = 0; channel < CHANNELS_PER_INSTANCE; channel += 1) {
      if (channel === PERCUSSION_CHANNEL && !allowNine) continue;
      if (!taken[instance].has(channel)) return channel;
    }
    return null;
  };

  const claim = (id: string, instance: number, channel: number, needsDrumTypeSwitch: boolean): void => {
    taken[instance].add(channel);
    assignments.set(id, { instance, channel, needsDrumTypeSwitch });
  };

  // Percussion first, so the free channel-9 slots go to the tracks that get
  // fluidsynth's default mapping for nothing.
  for (const track of tracks.filter((t) => t.isPercussion)) {
    const withNine = taken.findIndex((set) => !set.has(PERCUSSION_CHANNEL));
    if (withNine !== -1) {
      claim(track.id, withNine, PERCUSSION_CHANNEL, false);
      continue;
    }
    // No channel 9 left. Take an ordinary slot and switch its type rather than
    // opening an instance for the sake of one channel.
    let placed = false;
    for (let instance = 0; instance < taken.length && !placed; instance += 1) {
      const channel = freeChannel(instance, false);
      if (channel !== null) {
        claim(track.id, instance, channel, true);
        placed = true;
      }
    }
    if (!placed) {
      taken.push(new Set());
      claim(track.id, taken.length - 1, PERCUSSION_CHANNEL, false);
    }
  }

  for (const track of tracks.filter((t) => !t.isPercussion)) {
    let placed = false;
    for (let instance = 0; instance < taken.length && !placed; instance += 1) {
      const channel = freeChannel(instance, false);
      if (channel !== null) {
        claim(track.id, instance, channel, false);
        placed = true;
      }
    }
    if (!placed) {
      taken.push(new Set());
      claim(track.id, taken.length - 1, 0, false);
    }
  }

  return { assignments, instanceCount: taken.length };
}
