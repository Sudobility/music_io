/**
 * The worker protocol around the model, not the model itself.
 *
 * jsdom has neither `Worker` nor `OfflineAudioContext` nor a tensor backend, so
 * what is testable here is the part that can actually go wrong in review: which
 * messages are relayed, whether a dead worker leaves a promise pending, and
 * whether the thing is cleaned up. The model's own accuracy is Spotify's test
 * suite; the conversion to a score is `transcriptionFromHeardNotes`'s.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBasicPitchTranscriber } from './basic-pitch-transcriber.js';
import type { BasicPitchWorkerRequest } from './basic-pitch.worker.js';

/** A worker-shaped fake: records what it was posted, replies on demand. */
function fakeWorker() {
  const listeners = new Map<string, Set<(event: never) => void>>();
  const posted: BasicPitchWorkerRequest[] = [];
  const transfers: unknown[][] = [];
  const terminate = vi.fn();

  const emit = (type: string, event: unknown): void => {
    for (const fn of listeners.get(type) ?? []) (fn as (e: unknown) => void)(event);
  };

  return {
    posted,
    transfers,
    terminate,
    reply: (message: unknown) => emit('message', { data: message }),
    fail: (message: string) => emit('error', { message }),
    worker: {
      addEventListener: (type: string, fn: (event: never) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: (event: never) => void) => {
        listeners.get(type)?.delete(fn);
      },
      postMessage: (message: BasicPitchWorkerRequest, transfer?: unknown[]) => {
        posted.push(message);
        transfers.push(transfer ?? []);
      },
      terminate,
    } as unknown as Worker,
    messageListenerCount: () => listeners.get('message')?.size ?? 0,
  };
}

/** Already at the model's rate, so `resample` returns it untouched — jsdom has no OfflineAudioContext. */
const audio = { samples: new Float32Array(2048), sampleRate: 22050 };

describe('createBasicPitchTranscriber', () => {
  it('runs the model in a worker, and hands it the model URL', async () => {
    const fake = fakeWorker();
    const transcriber = createBasicPitchTranscriber({
      modelUrl: '/models/basic-pitch/model.json',
      createWorker: () => fake.worker,
    });

    const pending = transcriber.transcribe(audio);
    await vi.waitFor(() => expect(fake.posted).toHaveLength(1));
    expect(fake.posted[0].modelUrl).toBe('/models/basic-pitch/model.json');

    fake.reply({ type: 'transcribe', requestId: fake.posted[0].requestId, notes: [] });
    await pending;
  });

  it('relays progress, then resolves with the notes it heard', async () => {
    const fake = fakeWorker();
    const transcriber = createBasicPitchTranscriber({ modelUrl: '/m.json', createWorker: () => fake.worker });
    const seen: number[] = [];

    const pending = transcriber.transcribe(audio, { onProgress: (f) => seen.push(f) });
    await vi.waitFor(() => expect(fake.posted).toHaveLength(1));
    const { requestId } = fake.posted[0];
    fake.reply({ type: 'progress', requestId, fraction: 0.4 });
    fake.reply({
      type: 'transcribe',
      requestId,
      notes: [{ midi: 60, startSec: 0, durationSec: 1, amplitude: 0.8 }],
    });

    await expect(pending).resolves.toEqual([{ midi: 60, startSec: 0, durationSec: 1, amplitude: 0.8 }]);
    // 0.4 from the worker, then 1 on completion — a bar that stopped at 40%
    // because the last batch reported nothing would look stuck at the end.
    expect(seen).toEqual([0.4, 1]);
  });

  it('transfers the samples rather than copying them', async () => {
    const fake = fakeWorker();
    const transcriber = createBasicPitchTranscriber({ modelUrl: '/m.json', createWorker: () => fake.worker });

    const pending = transcriber.transcribe(audio);
    await vi.waitFor(() => expect(fake.transfers).toHaveLength(1));
    expect(fake.transfers[0]).toHaveLength(1);

    fake.reply({ type: 'transcribe', requestId: fake.posted[0].requestId, notes: [] });
    await pending;
  });

  it('rejects when the worker reports an error', async () => {
    const fake = fakeWorker();
    const transcriber = createBasicPitchTranscriber({ modelUrl: '/m.json', createWorker: () => fake.worker });

    const pending = transcriber.transcribe(audio);
    await vi.waitFor(() => expect(fake.posted).toHaveLength(1));
    fake.reply({ type: 'error', requestId: fake.posted[0].requestId, message: 'no backend' });

    await expect(pending).rejects.toThrow('no backend');
  });

  it('rejects when the worker dies outright, rather than hanging', async () => {
    // A long recording can exhaust worker memory. Without an `error` listener
    // the promise would stay pending and the dialog would spin for ever.
    const fake = fakeWorker();
    const transcriber = createBasicPitchTranscriber({ modelUrl: '/m.json', createWorker: () => fake.worker });

    const pending = transcriber.transcribe(audio);
    await vi.waitFor(() => expect(fake.posted).toHaveLength(1));
    fake.fail('worker died');

    await expect(pending).rejects.toThrow('worker died');
  });

  it('terminates the worker either way, so the model releases its memory', async () => {
    const fake = fakeWorker();
    const transcriber = createBasicPitchTranscriber({ modelUrl: '/m.json', createWorker: () => fake.worker });

    const pending = transcriber.transcribe(audio);
    await vi.waitFor(() => expect(fake.posted).toHaveLength(1));
    fake.reply({ type: 'error', requestId: fake.posted[0].requestId, message: 'nope' });
    await expect(pending).rejects.toThrow();

    expect(fake.terminate).toHaveBeenCalled();
    expect(fake.messageListenerCount()).toBe(0);
  });

  it('refuses rather than running the model on the main thread', async () => {
    // Inline would lock the window for the whole inference. Rejecting lets the
    // caller fall back to the monophonic tracker instead.
    const transcriber = createBasicPitchTranscriber({ modelUrl: '/m.json', createWorker: () => null });
    await expect(transcriber.transcribe(audio)).rejects.toThrow(/Worker/);
  });
});
