/**
 * Polyphonic transcription with Spotify's Basic Pitch (Apache-2.0).
 *
 * Replaces the monophonic YIN tracker for the web. YIN reports **one**
 * fundamental per frame by construction, so a chord imported as whichever
 * partial happened to dominate and a piano part imported as one wandering
 * line. Basic Pitch is a small CNN trained for exactly this and returns every
 * note it hears at once.
 *
 * What it does **not** do is tell you which instrument played what — it is
 * instrument-agnostic, and its own guidance is "one instrument at a time".
 * Splitting a mix into per-instrument parts is source separation, a different
 * and much heavier model; this is the note-finding half of that job.
 *
 * The model runs in a **worker** (`basic-pitch.worker.ts`) — it is the heaviest
 * work in the app, and on the main thread it freezes the window for its whole
 * duration, progress bar included. What stays here is the resampling, because
 * `OfflineAudioContext` is Window-scoped and a worker cannot reach it; the
 * resampled buffer is then transferred, which is also half the bytes.
 *
 * Everything is loaded **lazily**. TensorFlow.js is over a megabyte and nothing
 * else in the app needs it, so importing it at module scope would put it in the
 * entry bundle of every user who never imports a recording.
 */
import type {
  BasicPitchWorkerRequest,
  BasicPitchWorkerResponse,
} from './basic-pitch.worker.js';
import type {
  AudioTranscriber,
  DecodedAudio,
  HeardNote,
  TranscribeAudioOptions,
} from '@sudobility/music_types';

/**
 * The rate the model was trained at. Anything else has to be resampled first —
 * the model does not adapt, it just reads the wrong pitches.
 */
const MODEL_SAMPLE_RATE = 22050;

/**
 * Onset and frame thresholds.
 *
 * Basic Pitch's own defaults, stated rather than left implicit because they
 * are the two knobs that decide "missed a note" against "heard one that was
 * not played", and a future complaint about either lands here.
 */
const ONSET_THRESHOLD = 0.5;
const FRAME_THRESHOLD = 0.3;
/** Notes shorter than this are model noise rather than performance. */
const MIN_NOTE_FRAMES = 5;

/**
 * Resamples to the model's rate with an `OfflineAudioContext`.
 *
 * The browser's own resampler, rather than a hand-rolled one: it is already
 * there, it is correct, and naive decimation would alias every partial above
 * 11kHz down into the range the model is reading pitches from.
 */
async function resample(audio: DecodedAudio): Promise<Float32Array> {
  if (audio.sampleRate === MODEL_SAMPLE_RATE) return audio.samples;

  const frames = Math.ceil((audio.samples.length * MODEL_SAMPLE_RATE) / audio.sampleRate);
  const Ctor =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  const ctx = new Ctor(1, frames, MODEL_SAMPLE_RATE);

  const source = ctx.createBufferSource();
  const buffer = ctx.createBuffer(1, audio.samples.length, audio.sampleRate);
  // Copied into a fresh array rather than passed straight through: the caller's
  // samples may be a view over a larger buffer (a `subarray`), which
  // `copyToChannel` does not accept.
  buffer.copyToChannel(new Float32Array(audio.samples), 0);
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();

  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

export type BasicPitchAssets = {
  /**
   * Where the model's `model.json` is served from.
   *
   * Injected rather than resolved here for the same reason the soundfont and
   * worklet URLs are: music_io is a library and cannot know how a consuming
   * app serves assets.
   */
  modelUrl: string;
  /** Overrides worker construction, so a test can inject a worker-shaped fake. */
  createWorker?: () => Worker | null;
};

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Math.random().toString(36).slice(2)}`;
}

/** Module-worker URL form, as Vite requires for static analysis; `null` if construction throws. */
function defaultCreateWorker(): Worker | null {
  try {
    return new Worker(new URL('./basic-pitch.worker.js', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

export function createBasicPitchTranscriber(assets: BasicPitchAssets): AudioTranscriber {
  const spawn = assets.createWorker ?? (typeof Worker !== 'undefined' ? defaultCreateWorker : () => null);

  return {
    async transcribe(
      audio: DecodedAudio,
      options: TranscribeAudioOptions = {},
    ): Promise<HeardNote[]> {
      const worker = spawn();
      if (!worker) {
        // Deliberately not an inline fallback: running this model on the main
        // thread locks the window for its whole duration. Rejecting lets the
        // caller drop to music_lib's monophonic tracker, which is a worse
        // transcription but a usable app.
        throw new Error('Audio transcription needs a Worker, which this browser did not provide');
      }

      const samples = await resample(audio);
      const requestId = createRequestId();

      try {
        return await new Promise<HeardNote[]>((resolve, reject) => {
          const onMessage = (event: MessageEvent<BasicPitchWorkerResponse>): void => {
            const message = event.data;
            if (!message || message.requestId !== requestId) return;

            if (message.type === 'progress') {
              options.onProgress?.(message.fraction);
              return;
            }

            worker.removeEventListener('message', onMessage);
            if (message.type === 'transcribe') {
              options.onProgress?.(1);
              resolve(message.notes);
            } else {
              reject(new Error(message.message));
            }
          };

          worker.addEventListener('message', onMessage);
          // A worker that dies (out of memory on a long recording, say) would
          // otherwise leave this promise pending for good.
          worker.addEventListener('error', (event) =>
            reject(new Error(event.message || 'The transcription worker failed')),
          );

          const request: BasicPitchWorkerRequest = {
            type: 'transcribe',
            requestId,
            samples,
            modelUrl: assets.modelUrl,
            onsetThreshold: ONSET_THRESHOLD,
            frameThreshold: FRAME_THRESHOLD,
            minNoteFrames: MIN_NOTE_FRAMES,
          };
          // Transferred: the resampled buffer is this side's last use of it.
          worker.postMessage(request, [samples.buffer]);
        });
      } finally {
        // One worker per import rather than a long-lived one: the model holds
        // GPU memory for as long as it is alive, and an import is occasional.
        worker.terminate();
      }
    },
  };
}
