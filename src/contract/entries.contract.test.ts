// @vitest-environment jsdom
import { createMusicIo as createWebIo } from '../web/index.js';
import { createMusicIo as createMockIo } from '../mocks/index.js';
import { runPlatformContract } from './platform-contract.js';

// jsdom because the web parser needs a DOMParser; the mocks entry needs no DOM
// and is exercised again without one in mocks.contract.test.ts.
runPlatformContract('web', () => createWebIo());
runPlatformContract('mocks', createMockIo);
