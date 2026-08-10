/**
 * Fetches the soundfont once and keeps it in the Cache API.
 *
 * The font is tens of megabytes even as SF3, so this is the difference between
 * a wait on every visit and a wait on the first. `cache` is injected rather
 * than reached for globally, so tests need no real CacheStorage and a caller
 * without one still works — just without the caching.
 *
 * A failed fetch throws. Resolving an empty buffer would load a synth with no
 * instruments, which presents as silent playback with no error anywhere — the
 * exact failure this whole engine exists to stop happening.
 */
export type LoadProgress = { loaded: number; total: number };

/** Bumped when the stored representation changes, so old entries are not reused. */
const CACHE_NAME = 'music-soundfont-v1';

/**
 * The cache the soundfont lives in, or `null` where the Cache API is missing.
 *
 * Worth its own function because forgetting it is expensive and silent: without
 * a cache the font is refetched and re-decoded on every engine init and every
 * export — tens of megabytes and seconds of work each time, with nothing
 * visibly wrong.
 */
export async function openSoundfontCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null; // private browsing and similar; the font still loads
  }
}

export async function loadSoundfont(
  url: string,
  opts: { onProgress?: (progress: LoadProgress) => void; cache?: Cache | null } = {},
): Promise<ArrayBuffer> {
  const cached = await opts.cache?.match(url);
  if (cached) return await cached.arrayBuffer();

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Soundfont fetch failed: ${response.status} ${response.statusText} (${url})`);
  }

  const declared = Number(response.headers.get('content-length') ?? 0);
  opts.onProgress?.({ loaded: 0, total: declared });

  // Clone before reading: the response still has to go into the cache, and a
  // body can only be consumed once.
  const buffer = await response.clone().arrayBuffer();
  await opts.cache?.put(url, response);

  opts.onProgress?.({ loaded: buffer.byteLength, total: declared || buffer.byteLength });
  return buffer;
}
