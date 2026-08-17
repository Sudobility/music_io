/**
 * The `TrackerCodec` capability, for all three platforms.
 *
 * One implementation, not three: nothing about reading a module is
 * platform-bound. The capability exists so the app reaches every file format
 * the same way — through `getAppServices().io` — rather than importing a
 * parser directly for this one format.
 */
import type { TrackerCodec, TrackerModule } from '@sudobility/music_types';
import { readMod } from './read.js';

export class SharedTrackerCodec implements TrackerCodec {
  decode(bytes: ArrayBuffer): TrackerModule {
    // MOD only, for now. The other formats get their own readers behind this
    // same entry point, selected by magic bytes.
    return readMod(bytes);
  }
}
