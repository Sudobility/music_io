import { describe, expect, it } from 'vitest';
import { gmPackName } from './gm-pack-name.js';

describe('gmPackName', () => {
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
