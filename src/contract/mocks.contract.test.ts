import { createMusicIo } from "../mocks/index.js";
import { runPlatformContract } from "./platform-contract.js";

// Deliberately no jsdom: the mocks entry must work with no DOM at all, which is
// what makes it usable from a React Native test run.
runPlatformContract("mocks (no DOM)", createMusicIo);
