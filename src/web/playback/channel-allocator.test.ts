import { describe, expect, it } from 'vitest';
import { allocateChannels } from './channel-allocator.js';

const pitched = (id: string) => ({ id, isPercussion: false });
const drums = (id: string) => ({ id, isPercussion: true });

describe('allocateChannels', () => {
  it('puts a drum track on channel 9, which GM maps to percussion by default', () => {
    // Verified in spikes/js-synthesizer-in-audioworklet.md: channel 9 sounds
    // only if left alone. Anything that needs an explicit select is worse off.
    const { assignments, instanceCount } = allocateChannels([drums('d')]);
    expect(assignments.get('d')).toEqual({ instance: 0, channel: 9, needsDrumTypeSwitch: false });
    expect(instanceCount).toBe(1);
  });

  it('never gives channel 9 to a pitched track', () => {
    // A pitched track there would play drums, because fluidsynth forces the
    // percussion bank on channel 9.
    const { assignments } = allocateChannels(Array.from({ length: 15 }, (_, i) => pitched(`p${i}`)));
    for (const a of assignments.values()) expect(a.channel).not.toBe(9);
  });

  it('fits 15 pitched tracks in one instance and opens a second for the 16th', () => {
    const tracks = Array.from({ length: 16 }, (_, i) => pitched(`p${i}`));
    const { assignments, instanceCount } = allocateChannels(tracks);
    expect(instanceCount).toBe(2);
    expect(assignments.get('p15')?.instance).toBe(1);
  });

  it('gives a second drum track an ordinary channel switched to drum type, not a whole new instance', () => {
    // Opening a second synth instance just to reach another channel 9 would
    // cost a full 16-channel synth for one extra drum part. `midiSetChannelType`
    // marks any channel as percussion, so an ordinary slot does.
    const { assignments, instanceCount } = allocateChannels([drums('d1'), drums('d2')]);
    expect(assignments.get('d1')).toEqual({ instance: 0, channel: 9, needsDrumTypeSwitch: false });
    const second = assignments.get('d2');
    expect(second?.instance).toBe(0);
    expect(second?.channel).not.toBe(9);
    expect(second?.needsDrumTypeSwitch).toBe(true);
    expect(instanceCount).toBe(1);
  });

  it('assigns every track exactly one distinct slot', () => {
    const tracks = [drums('d'), ...Array.from({ length: 40 }, (_, i) => pitched(`p${i}`))];
    const { assignments } = allocateChannels(tracks);
    expect(assignments.size).toBe(41);
    const slots = new Set([...assignments.values()].map((a) => `${a.instance}:${a.channel}`));
    expect(slots.size).toBe(41);
  });

  it('handles a score with no tracks', () => {
    const { assignments, instanceCount } = allocateChannels([]);
    expect(assignments.size).toBe(0);
    expect(instanceCount).toBe(1);
  });
});
