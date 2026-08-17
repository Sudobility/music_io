import { describe, expect, it } from 'vitest';
import { SharedTrackerCodec } from './codec.js';
import { buildMod } from './fixture.js';
import { buildDsm } from '../tracker/dsm-fixture.js';
import { buildS3m } from '../tracker/s3m-fixture.js';
import { buildXm } from '../tracker/xm-fixture.js';

describe('SharedTrackerCodec', () => {
  const codec = new SharedTrackerCodec();

  it('decodes a ProTracker module', () => {
    expect(codec.decode(buildMod({ title: 'Elysium' })).format).toBe('mod');
  });

  it('decodes a DSM module', () => {
    expect(codec.decode(buildDsm({ title: 'Race' })).format).toBe('dsm');
  });

  it('chooses by magic bytes rather than by extension, which it never sees', () => {
    // A mis-named file still imports; that is the whole reason for sniffing.
    expect(codec.decode(buildDsm({})).format).toBe('dsm');
    expect(codec.decode(buildMod({})).format).toBe('mod');
  });

  it('decodes a Scream Tracker module', () => {
    expect(codec.decode(buildS3m({ title: 'Portal' })).format).toBe('s3m');
  });

  it('decodes a FastTracker module', () => {
    expect(codec.decode(buildXm({ title: 'sunlight' })).format).toBe('xm');
  });

  it('names what it found when it recognises nothing', () => {
    const junk = new Uint8Array(2000);
    junk.set([0x50, 0x4b, 0x03, 0x04], 0); // a zip
    expect(() => codec.decode(junk.buffer)).toThrow(/not a .*module/i);
  });
});
