// @vitest-environment jsdom
import { createMusicIo as createWebIo } from '../web/index.js';
import { createMusicIo as createMockIo } from '../mocks/index.js';
import { runPlatformContract } from './platform-contract.js';

// The web entry needs soundfont asset URLs. Nothing in the contract loads them —
// it exercises the parsers, codecs and exporter — so placeholders are honest
// here: fetching only happens once playback or export is actually driven.
const soundfont = { fluidsynthModuleUrl: '/f.js', workletModuleUrl: '/w.js', fontUrl: '/font.sf3' };

// jsdom because the web parser needs a DOMParser; the mocks entry needs no DOM
// and is exercised again without one in mocks.contract.test.ts.
runPlatformContract('web', () => createWebIo({ soundfont }));
runPlatformContract('mocks', createMockIo);
