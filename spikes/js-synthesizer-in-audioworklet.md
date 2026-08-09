# Spike: does `js-synthesizer` run in an AudioWorklet, and is it fast enough?

Run 2026-08-09, as the gate on
`docs/superpowers/specs/2026-08-09-soundfont-playback-engine-design.md`. That
design rests on one unverified assumption; this is it.

## What ran

A standalone page rendering through `OfflineAudioContext` + `AudioWorklet`, so
the result is deterministic and needs no audio device:

```
libfluidsynth-2.4.6-with-libsndfile.js  (addModule)
js-synthesizer.worklet.js               (addModule)
JSSynth.AudioWorkletNodeSynthesizer     -> createAudioNode -> destination
FluidR3Mono_GM.sf3  (23MB, from musescore/MuseScore share/sound)
```

Source kept out of the repo: it needs a 23MB soundfont it should not carry. The
page is reproducible from this document.

## Results

| Question | Answer |
| --- | --- |
| `audioWorklet` on `OfflineAudioContext` | yes |
| Both modules load in a worklet | yes |
| SF3 (Vorbis-compressed) loads | yes — **requires the `-with-libsndfile` build** |
| A note produces audio | yes, peak 0.091 |
| 64 simultaneous voices | peak 1.004, **91ms to render 4000ms of audio — 2.3% of realtime** |
| Interpolation is a real CPU knob | yes — `setInterpolation(0)` renders the same passage in 53% of the time |
| SF3 load cost | ~4.7s for 23MB, every time the font is loaded |

The headline is the third-from-last row. Sixty-four voices at 2.3% of realtime is
roughly forty times the headroom needed, on a machine rendering offline. That is
the difference in cost class the design predicted, and it is what makes the
"runs on reasonable computers" goal reachable.

Peak 1.004 on 64 voices also confirms the master limiter stays: summing many
channels still exceeds full scale, exactly as it did with the Tone engine.

## Build sizes

| File | Size |
| --- | --- |
| `libfluidsynth-2.4.6.js` | 558K |
| `libfluidsynth-2.4.6-with-libsndfile.js` | 2.3M |
| `js-synthesizer.worklet.min.js` | 30K |

SF3 costs 1.7MB of extra WASM over the plain build. Worth it: SF3 is what keeps
the *font* to tens of megabytes instead of hundreds.

## Open, and needed before implementation

### RESOLVED — percussion: do not select a program on channel 9

Five routes were measured. Only one sounds:

| Route | Peak |
| --- | --- |
| **ch9, no program select at all** | **0.3120** |
| ch9, `midiProgramSelect(9, sfontId, 128, 0)` | 0.0000 |
| ch9, `CC0=1` + `midiProgramChange(9, 0)` | 0.0000 |
| ch9, single note after bank-128 select | 0.0000 |
| ch0 with bank-128 preset 0 | 0.0000 |

The font's bank offset is 0. FluidSynth's GM mode already maps channel 9 to the
percussion bank, and the explicit select was what *silenced* it — it replaced a
working default with a preset that does not exist at that address.

**Rule for the implementation: leave channel 9 at its default. Never call
`midiProgramSelect` on a percussion channel.**

The member probe also turned up `midiSetChannelType` / `setChannelType`, which
marks an arbitrary channel as a drum channel. That is what lets a score carry
more than one percussion track: extra drum tracks take an ordinary channel and
are switched to drum type, rather than each needing its own synth instance for
its own channel 9. It simplifies `ChannelAllocator` — verify it before relying
on it.

### RESOLVED — polyphony is not reachable, and does not need to be

The full member list carries no polyphony setter. The escape hatches
(`_getRawSynthesizer`, `callFunction`) exist but are private.

This does not block the design. FluidSynth already steals voices at its default
polyphony, which is the behaviour the ladder's second rung was asking for — it
happens automatically rather than needing a cap. So the ladder becomes:
interpolation order (confirmed working, halves render time), then fluidsynth's
own stealing. An explicit cap is deferred until measurement shows it is needed,
and would go through the raw-synthesizer hatch.

**Load time is not free.** ~4.7s to decode 23MB of SF3, on top of the download.
With playback blocked until ready, first run is download + ~5s. Caching the
*decoded* state is not obviously possible, so this may be paid on every page
load, not just the first — worth measuring before committing to the blocking
UX.

## Licensing — decide before building

| Component | Licence |
| --- | --- |
| `js-synthesizer` | BSD 3-clause |
| **libfluidsynth** | **LGPL 2.1** |
| `music_io` | BUSL-1.1 |

`js-synthesizer` is permissive and fine. **libfluidsynth is LGPL 2.1**, which is
a real question against a BUSL-1.1 product and was not considered in the design.
The usual compliance path — shipping the LGPL component as a separate,
replaceable artifact with attribution and licence text — fits how this loads
(`addModule` of an unmodified standalone file), but that is an argument, not a
ruling, and WASM/JS LGPL boundaries are not well settled.

For contrast, Tone.js is MIT and raises none of this.

This is a decision for the project owner, not a technical detail to route
around. If LGPL is unacceptable, the design needs a different engine and the
spike needs rerunning against it.

## Verdict

The technical assumption holds, with room to spare. Both configuration questions are answered above: percussion works by leaving
channel 9 alone, and polyphony needs no setter because fluidsynth already
steals. Nothing technical blocks implementation.

The licence question remains, and the project owner has chosen to proceed and
revisit it later. The terms are recorded here so that decision stays visible.
