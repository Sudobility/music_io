# Spike: does Tone.js run on `react-native-audio-api`?

Run 2026-07-31, before any of the platform boundary was built, because Task 13's
shape depends on the answer.

## What ran

```
cd ~/projects/music_io && bun spikes/probe.mjs
```

```
 * Tone.js v15.1.22 *
OK    import tone
BREAK import react-native-audio-api -> ResolveMessage: Cannot find package
      'react-native-gesture-handler' from
      '.../react-native-audio-api/lib/module/Audio/controls/AudioC...'
```

The package barrel pulls in UI controls, so a second probe tried the audio core
directly, skipping them:

```
BREAK .../lib/module/core/AudioContext.js -> Cannot find package 'react-native'
BREAK .../lib/module/api.web.js          -> Cannot find package 'react'
```

## Verdict

**Unproven outside a device.** `react-native-audio-api` requires `react-native`
at import time, so no amount of Node/Bun probing can answer whether Tone runs on
it. This is a property of the library, not a defect in the probe — there is no
JS-only build to test against.

What *is* established, and is favourable:

- Tone.js itself imports cleanly with no DOM present (it printed its banner
  above in a Bun process with no `window` or `document`).
- Every Web Audio node our synths compile down to is implemented by
  `react-native-audio-api`: `OscillatorNode`, `GainNode`, `BiquadFilterNode`,
  `AudioBufferSourceNode`, `StereoPannerNode`, `PeriodicWave`,
  `ConstantSourceNode`, `OfflineAudioContext`.
- Its two gaps — `AudioWorklet` and `DynamicsCompressorNode` — are needed only
  by Tone's `BitCrusher` and `FeedbackCombFilter`, neither of which we use.
- Tone's transport clock prefers a Web Worker and falls back to `setTimeout`,
  which is React Native's situation.
- Software Mansion state that Web Audio compatibility exists precisely so
  libraries like Tone.js can be used from React Native.

## Consequence for Task 13

The plan's written fallback for this verdict was "implement `PlaybackEngine`
directly against `react-native-audio-api`'s nodes". **Deviating from that, on
purpose**, to the cheaper path:

`RNPlaybackEngine` subclasses the moved `TonePlaybackEngine` and swaps the audio
context in `initialize()` — roughly twenty lines — and ships documented as
*unverified on device*.

The reasoning: writing a synthesis engine from scratch is days of work whose
only justification is a risk nobody can measure from here. The entire point of
putting playback behind `PlaybackEngine` is that this decision is reversible —
if device testing shows Tone will not run, replacing the subclass with a direct
implementation touches one file in `music_io` and nothing in `music_lib` or
`music_app`. Paying the full cost now to hedge an unmeasurable risk would be
buying insurance the architecture already provides.

**Contingency:** if a device test fails, implement `PlaybackEngine` directly
against `react-native-audio-api`'s nodes, scheduling from `context.currentTime`
and driving `onPositionTick` from a 30Hz interval. The observer contract must
stay identical — the controller must not be able to tell the platforms apart.

**This is a known open risk, not a solved problem.** It is recorded in
`music_io`'s CLAUDE.md so it cannot quietly become an assumption.
