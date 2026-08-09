import * as midiModule from '@tonejs/midi';
import type { MidiCodec, MidiControlChange, MidiFile, MidiTrackData } from '@sudobility/music_types';

type MidiConstructor = typeof import('@tonejs/midi').Midi;
type ToneMidiTrack = InstanceType<MidiConstructor>['tracks'][number];

/**
 * `@tonejs/midi` publishes CommonJS as `main` and ESM only via `module`, with
 * no `exports` map — so whether a named import works depends entirely on which
 * build the resolver picked. Bun and Vite pick the ESM build and a named import
 * is fine; Node's ESM loader takes `main` and cannot always detect the named
 * exports of a bundled CommonJS file, which fails at import time with
 * "Named export 'Midi' not found".
 *
 * Reading the constructor off the namespace instead works under every resolver.
 * This is the concrete cost of the one CommonJS dependency in the family.
 */
const namespace = midiModule as unknown as { Midi?: MidiConstructor; default?: { Midi: MidiConstructor } };
const Midi: MidiConstructor = namespace.Midi ?? namespace.default?.Midi ?? missingMidi();

function missingMidi(): never {
  throw new Error('@tonejs/midi did not export Midi under any known module shape.');
}

function controlChangesFor(track: ToneMidiTrack): MidiTrackData['controlChanges'] {
  return Object.fromEntries(
    Object.entries(track.controlChanges).map(([number, events]) => [
      Number(number),
      (events ?? []).map(
        (cc): MidiControlChange => ({ number: cc.number, ticks: cc.ticks, value: cc.value }),
      ),
    ]),
  );
}

function isTickZeroSetupTrack(track: MidiTrackData): boolean {
  return (
    track.notes.length === 0 &&
    track.durationTicks === 0 &&
    Object.values(track.controlChanges).some((events) => events.some((event) => event.ticks === 0))
  );
}

/**
 * Format-0 files sometimes decode through `@tonejs/midi` as alternating
 * control-only setup tracks and note tracks. The setup track has the CC7/CC10
 * values from the original channel, while the following note track has the
 * program/channel but no controllers. Copy those tick-0 controllers forward so
 * import/playback keeps the source mix.
 */
function withFormatZeroSetupControls(tracks: MidiTrackData[]): MidiTrackData[] {
  return tracks.map((track, index) => {
    if (track.notes.length === 0) return track;

    const previous = tracks[index - 1];
    if (!previous || !isTickZeroSetupTrack(previous)) return track;

    const controlChanges = { ...track.controlChanges };
    let changed = false;
    for (const [number, events] of Object.entries(previous.controlChanges)) {
      const ccNumber = Number(number);
      if (controlChanges[ccNumber]?.length) continue;
      controlChanges[ccNumber] = events;
      changed = true;
    }

    return changed ? { ...track, controlChanges } : track;
  });
}

/**
 * `@tonejs/midi` behind the neutral model.
 *
 * Deliberately shared by both platform entries. Standard MIDI File encoding is
 * byte manipulation with no platform APIs, and this library already works under
 * Metro, so the web and React Native implementations are the same code. The
 * seam exists for a different reason: music_lib carries no MIDI dependency of
 * its own, and a future ESM codec can replace this one without music_lib
 * changing. It does not, by itself, remove CommonJS from the dependency graph.
 */
export class ToneJsMidiCodec implements MidiCodec {
  decode(data: ArrayBuffer): MidiFile {
    const midi = new Midi(data);
    const tracks = midi.tracks.map(
      (track): MidiTrackData => ({
        name: track.name,
        channel: track.channel,
        instrument: { number: track.instrument.number, name: track.instrument.name },
        notes: track.notes.map((note) => ({
          midi: note.midi,
          ticks: note.ticks,
          durationTicks: note.durationTicks,
          velocity: note.velocity,
        })),
        // Kept keyed by CC number: the importer looks up sustain (64),
        // volume (7) and pan (10) directly, and flattening them here would
        // lose volume and pan silently.
        controlChanges: controlChangesFor(track),
        durationTicks: track.durationTicks,
        durationSeconds: track.duration,
      }),
    );

    return {
      header: {
        ppq: midi.header.ppq,
        name: midi.header.name,
        tempos: midi.header.tempos.map((tempo) => ({ ticks: tempo.ticks, bpm: tempo.bpm })),
        timeSignatures: midi.header.timeSignatures.map((signature) => ({
          ticks: signature.ticks,
          timeSignature: [signature.timeSignature[0], signature.timeSignature[1]] as [number, number],
        })),
      },
      tracks: withFormatZeroSetupControls(tracks),
      duration: midi.duration,
    };
  }

  encode(file: MidiFile): Uint8Array {
    const midi = new Midi();
    midi.header.fromJSON({
      name: file.header.name ?? '',
      ppq: file.header.ppq,
      meta: [],
      tempos: file.header.tempos.map((tempo) => ({ ticks: tempo.ticks, bpm: tempo.bpm })),
      timeSignatures: file.header.timeSignatures.map((signature) => ({
        ticks: signature.ticks,
        timeSignature: signature.timeSignature,
      })),
      keySignatures: [],
    });

    for (const track of file.tracks) {
      const midiTrack = midi.addTrack();
      midiTrack.name = track.name;
      midiTrack.channel = track.channel;
      midiTrack.instrument.number = track.instrument.number;
      for (const events of Object.values(track.controlChanges)) {
        for (const cc of events) {
          midiTrack.addCC({ number: cc.number, ticks: cc.ticks, value: cc.value });
        }
      }
      for (const note of track.notes) {
        midiTrack.addNote({
          midi: note.midi,
          ticks: note.ticks,
          durationTicks: note.durationTicks,
          velocity: note.velocity,
        });
      }
    }

    return midi.toArray();
  }
}
