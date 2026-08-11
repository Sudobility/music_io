/**
 * Module worker running the Basic Pitch model, mirroring music_lib's
 * `quantize.worker.ts` / `transcribe.worker.ts`.
 *
 * The model is the heaviest thing this app runs — seconds to minutes of solid
 * tensor work depending on the recording and whether the browser gives
 * TensorFlow.js a GPU backend. On the main thread that is a frozen window: no
 * repaint, so the progress bar reporting the work would itself be unable to
 * move, which is the exact trap the YIN tracker was moved off the main thread
 * to avoid.
 *
 * **Samples arrive already resampled.** `OfflineAudioContext` is Window-scoped
 * and does not exist in a worker, so the caller does that part and transfers
 * the result — which is also half the bytes, since the model's 22050Hz is well
 * under a typical file's rate.
 *
 * TensorFlow.js is imported dynamically here as well: a worker that is spawned
 * and never used should not pay for it either.
 */

/**
 * TensorFlow.js's browser platform calls `window.setTimeout` — and a worker has
 * no `window`, so its WebGL backend throws `ReferenceError: window is not
 * defined` the moment it waits on a GPU fence. Aliasing the worker's own global
 * is the standard workaround, and it has to happen **before** tfjs is imported,
 * which is why it sits at module scope rather than inside the handler.
 */
(globalThis as { window?: unknown }).window ??= globalThis;

export type BasicPitchWorkerRequest = {
  type: 'transcribe';
  requestId: string;
  /** Mono, already at the model's sample rate. */
  samples: Float32Array;
  modelUrl: string;
  onsetThreshold: number;
  frameThreshold: number;
  minNoteFrames: number;
};

/** Notes in seconds — the same shape `AudioTranscriber` resolves with. */
export type BasicPitchWorkerNote = {
  midi: number;
  startSec: number;
  durationSec: number;
  amplitude: number;
};

export type BasicPitchWorkerResponse =
  | { type: 'progress'; requestId: string; fraction: number }
  | { type: 'transcribe'; requestId: string; notes: BasicPitchWorkerNote[] }
  | { type: 'error'; requestId: string; message: string };

self.onmessage = (event: MessageEvent<BasicPitchWorkerRequest>) => {
  const request = event.data;
  if (request?.type !== 'transcribe') return;

  void (async () => {
    const post = (message: BasicPitchWorkerResponse): void => {
      self.postMessage(message);
    };

    try {
      // TensorFlow.js first, and configured before anything asks it to compute.
      // Basic Pitch imports the same module instance, so flags set here apply
      // to the model's own work.
      const tf = await import('@tensorflow/tfjs');
      // The WebGL fence API is what fails in a worker: tfjs polls the fence
      // through `window.setTimeout`, and `window` is a Window-scoped name. The
      // aliasing above covers most of it, but the fence path reads the global
      // captured inside the pre-bundled dependency, so this turns the path off
      // rather than relying on that. Readback then uses the non-fence route,
      // which costs a little throughput and works.
      tf.env().set('WEBGL_FENCE_API_ENABLED', false);
      await tf.ready();

      const { BasicPitch, noteFramesToTime, outputToNotesPoly, addPitchBendsToNoteEvents } =
        await import('@spotify/basic-pitch');

      const basicPitch = new BasicPitch(request.modelUrl);
      const frames: number[][] = [];
      const onsets: number[][] = [];
      const contours: number[][] = [];

      await basicPitch.evaluateModel(
        request.samples,
        (frame, onset, contour) => {
          // Called once per batch, so these accumulate rather than replace.
          frames.push(...frame);
          onsets.push(...onset);
          contours.push(...contour);
        },
        (percent) => post({ type: 'progress', requestId: request.requestId, fraction: percent }),
      );

      const notes = noteFramesToTime(
        addPitchBendsToNoteEvents(
          contours,
          outputToNotesPoly(
            frames,
            onsets,
            request.onsetThreshold,
            request.frameThreshold,
            request.minNoteFrames,
          ),
        ),
      );

      post({
        type: 'transcribe',
        requestId: request.requestId,
        notes: notes.map((note) => ({
          midi: note.pitchMidi,
          startSec: note.startTimeSeconds,
          durationSec: note.durationSeconds,
          amplitude: note.amplitude,
        })),
      });
    } catch (error) {
      // The backend rides along: "no backend" and "the GPU path broke" are
      // different problems with the same symptom, and the difference is not
      // recoverable from a stack trace in a worker.
      let backend = 'unknown';
      try {
        const tf = await import('@tensorflow/tfjs');
        backend = tf.getBackend() ?? 'none';
      } catch {
        // Reporting the original failure matters more than naming the backend.
      }
      post({
        type: 'error',
        requestId: request.requestId,
        message: `${error instanceof Error ? error.message : String(error)} (tfjs backend: ${backend})`,
      });
    }
  })();
};
