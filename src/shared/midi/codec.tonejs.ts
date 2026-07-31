import { Midi } from '@tonejs/midi';
import type { MidiCodec, MidiControlChange, MidiFile, MidiTrackData } from '@sudobility/music_types';

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
      tracks: midi.tracks.map(
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
          controlChanges: Object.fromEntries(
            Object.entries(track.controlChanges).map(([number, events]) => [
              Number(number),
              (events ?? []).map(
                (cc): MidiControlChange => ({ number: cc.number, ticks: cc.ticks, value: cc.value }),
              ),
            ]),
          ),
          durationTicks: track.durationTicks,
          durationSeconds: track.duration,
        }),
      ),
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
