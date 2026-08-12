import { describe, expect, it } from 'vitest';
import { GM_INSTRUMENTS } from '@sudobility/music_lib';
import { gmPackName } from './gm-pack-name.js';
import PACK_NAMES from './pack-names.json' with { type: 'json' };

/**
 * The manifest the CDN serves, vendored as `pack-names.json`.
 *
 * Vendored rather than fetched: a test that reaches the network fails on a
 * plane and, worse, passes when the mapping is wrong but the CDN happens to be
 * unreachable. The file is 128 short strings and changes when the packs do,
 * which is the thing worth noticing.
 */
const available = new Set<string>(PACK_NAMES);

describe('gmPackName', () => {
  it('names a pack that exists for every one of the 128 GM programs', () => {
    // The check that matters. A name that misses resolves to a 404, which
    // parses to no samples, which is an instrument that plays nothing.
    const missing = GM_INSTRUMENTS.filter((i) => !available.has(gmPackName(i.program, i.name))).map(
      (i) => `${i.program} "${i.name}" -> ${gmPackName(i.program, i.name)}`,
    );
    expect(missing).toEqual([]);
  });

  it('covers the whole catalogue, so no program silently has no rule', () => {
    expect(GM_INSTRUMENTS).toHaveLength(128);
  });

  it('removes punctuation rather than separating on it', () => {
    // The rule you would guess gives `honky_tonk_piano`, which does not exist.
    expect(gmPackName(3, 'Honky-tonk Piano')).toBe('honkytonk_piano');
    expect(gmPackName(103, 'FX 8 (sci-fi)')).toBe('fx_8_scifi');
  });

  it('leaves the double underscore where a `+` was, because the packs do', () => {
    expect(gmPackName(87, 'Lead 8 (bass + lead)')).toBe('lead_8_bass__lead');
  });

  it('uses the GM standard name for program 54, which the catalogue calls something else', () => {
    expect(gmPackName(54, 'Synth Voice')).toBe('voice_oohs');
  });
});
