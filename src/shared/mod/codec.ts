/**
 * The `ModCodec` capability, for all three platforms.
 *
 * One implementation, not three: nothing about reading a module is
 * platform-bound. The capability exists so the app reaches every file format
 * the same way — through `getAppServices().io` — rather than importing a
 * parser directly for this one format.
 */
import type { ModCodec, ModFile } from '@sudobility/music_types';
import { readMod } from './read.js';

export class SharedModCodec implements ModCodec {
  decode(bytes: ArrayBuffer): ModFile {
    return readMod(bytes);
  }
}
