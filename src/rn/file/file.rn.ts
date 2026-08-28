import type { FileExporter } from "@sudobility/music_types";
import { bytesToBase64 } from "@sudobility/music_types";

/** The subset of `react-native-fs` this needs, structural so a test can stand in for it. */
type RNFSLike = {
  CachesDirectoryPath: string;
  /**
   * Where a saved file goes on a platform that has no share sheet.
   *
   * macOS has a filesystem the user browses, which is the whole reason the
   * share sheet exists on iOS — so there, a saved file is a *file*, in the
   * place a desktop app puts one.
   */
  DownloadDirectoryPath?: string;
  /**
   * The fallback when there is no Downloads path.
   *
   * `react-native-fs` does not define `DownloadDirectoryPath` on macOS —
   * measured, not assumed: exports landed in `~/Library/Caches` because the
   * chain fell all the way through. Documents is the last stop before that,
   * because a cache directory is not somewhere a person looks for their work.
   */
  DocumentDirectoryPath?: string;
  exists?: (path: string) => Promise<boolean>;
  writeFile: (
    path: string,
    contents: string,
    encoding: string,
  ) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  readDir: (path: string) => Promise<RNFSEntry[]>;
  unlink: (path: string) => Promise<void>;
};

type RNFSEntry = {
  name: string;
  path: string;
  mtime?: Date | null;
};

type RNShareLike = {
  open: (options: Record<string, unknown>) => Promise<unknown>;
};

export type RNFileExporterDeps = {
  /**
   * `share` is nullable, and that is the macOS case rather than an oversight.
   * `react-native-share`'s podspec is `s.platform = :ios`, so CocoaPods never
   * installs it there and its module throws from `getEnforcing('RNShare')` at
   * *import* time — which is why it is loaded in a try of its own below rather
   * than guarded at the call.
   */
  loadModules?: () => Promise<{ fs: RNFSLike; share: RNShareLike | null }>;
  makeExportId?: () => string;
  /**
   * Set false where the platform's share sheet cannot take a file.
   *
   * Told, not detected — see `MusicIoOptions.shareSheet`. macOS resolves the
   * share module and then does nothing with it, so there is no failure to
   * observe from in here.
   */
  shareSheet?: boolean;
};

/**
 * Exports get their own directory under the cache.
 *
 * Not written straight into `CachesDirectoryPath`, which the OS and every other
 * library also use — sweeping that clean is indistinguishable from deleting
 * somebody else's files. A directory of our own is what makes the cleanup below
 * possible at all.
 */
const EXPORT_DIR = "scoresmith-exports";

/**
 * How many exports survive a cleanup.
 *
 * One, not zero. The obvious fix — delete the file once `share.open()` resolves
 * — races the share sheet: that promise settles when the sheet is dismissed,
 * which is not the same moment the receiving app has finished reading, and
 * "Save to Files" in particular is still copying. So nothing is deleted while it
 * could plausibly still be in use; the previous export is swept away by the
 * *next* one, by which point its sheet is long closed.
 *
 * Keeping one rather than none also covers two exports in flight at once: the
 * older file survives its own share, and only goes when a third export arrives.
 */
const KEEP_RECENT_EXPORTS = 1;
let exportCounter = 0;

async function defaultLoadModules(): Promise<{
  fs: RNFSLike;
  share: RNShareLike | null;
}> {
  const fsModule = await import("react-native-fs");
  const fs = ((fsModule as { default?: unknown }).default ??
    fsModule) as RNFSLike;

  /*
    Its own try, and deliberately not part of a `Promise.all` with the one
    above: `react-native-share` is iOS/Android only, and on macOS its index
    calls `TurboModuleRegistry.getEnforcing('RNShare')` at module scope. So the
    failure is at *import*, not at `share.open()`, and a rejected member of a
    `Promise.all` would take the filesystem module down with it.
  */
  let share: RNShareLike | null = null;
  try {
    const shareModule = await import("react-native-share");
    share = ((shareModule as { default?: unknown }).default ??
      shareModule) as RNShareLike;
  } catch {
    // Import threw — no share sheet. `save` writes a real file instead.
  }
  return { fs, share };
}

function safeFilename(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[/\\]/g, "_")
    // A NUL truncates the name at the OS layer, so what is written is not what
    // was asked for.
    .replace(/[\t\n\r\0]/g, "")
    .trim();
  return !cleaned || cleaned === "." || cleaned === ".." ? "export" : cleaned;
}

function defaultExportId(): string {
  exportCounter = (exportCounter + 1) % Number.MAX_SAFE_INTEGER;
  const time = Date.now().toString(36);
  const serial = exportCounter.toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${time}-${serial}-${random}`;
}

/**
 * Removes everything but the most recent exports.
 *
 * Runs before the new file is written, so it can never delete what this call is
 * about to share. Failure is swallowed: housekeeping must not lose the user
 * their export, and an unreadable cache directory is the OS's business.
 */
async function pruneOldExports(fs: RNFSLike, dir: string): Promise<void> {
  try {
    const entries = await fs.readDir(dir);
    const exports = entries.sort(
      (a, b) => (b.mtime?.getTime() ?? 0) - (a.mtime?.getTime() ?? 0),
    );
    for (const stale of exports.slice(KEEP_RECENT_EXPORTS)) {
      await fs.unlink(stale.path).catch(() => undefined);
    }
  } catch {
    // No directory yet, or it cannot be read. Either way there is nothing to
    // clean and the export itself is unaffected.
  }
}

/**
 * Writes the file to the app's cache directory, then opens the system share
 * sheet — React Native's equivalent of a browser download, since there is no
 * filesystem the user browses directly.
 *
 * Exports accumulate otherwise: every save used to leave a copy behind, and an
 * audio export is tens of megabytes. They go in a directory of their own and
 * each save sweeps the previous ones — see `pruneOldExports` for why cleanup
 * happens on the way in rather than after the share.
 *
 * `react-native-fs` and `react-native-share` are imported lazily so that merely
 * loading this module on a machine without them (the test runner, a Node
 * script) does not throw. Only `save()` needs them.
 */
export class RNFileExporter implements FileExporter {
  constructor(private readonly deps: RNFileExporterDeps = {}) {}

  async save(
    name: string,
    data: Uint8Array | string,
    mimeType: string,
  ): Promise<void> {
    const { fs, share: loaded } = await (this.deps.loadModules ??
      defaultLoadModules)();
    const share = this.deps.shareSheet === false ? null : loaded;

    /*
      Two ways there is no share sheet, and both have to be caught.

      `react-native-share` is iOS/Android only. On macOS the import sometimes
      throws outright (its module calls `getEnforcing('RNShare')` at module
      scope) and sometimes resolves to a module whose `open` then throws for
      the same missing native module — which of the two you get depends on how
      the bundler resolved it. Only the second was happening here, which is why
      guarding the import alone still left the export failing silently and the
      file stranded in a cache directory.

      So the share sheet is *attempted*, and any failure falls through to
      writing a real file. On a platform that has a share sheet nothing
      changes; on one that does not, the user gets their export.
    */
    if (share) {
      try {
        await this.saveViaShare(fs, share, name, data, mimeType);
        return;
      } catch {
        // No usable share sheet. Fall through and write a file instead.
      }
    }
    await this.saveToDownloads(fs, name, data);
  }

  /** iOS/Android: a temporary copy handed to the system share sheet. */
  private async saveViaShare(
    fs: RNFSLike,
    share: RNShareLike,
    name: string,
    data: Uint8Array | string,
    mimeType: string,
  ): Promise<void> {
    const dir = `${fs.CachesDirectoryPath}/${EXPORT_DIR}`;
    await fs.mkdir(dir).catch(() => undefined);
    await pruneOldExports(fs, dir);

    const exportDir = `${dir}/${safeFilename((this.deps.makeExportId ?? defaultExportId)())}`;
    await fs.mkdir(exportDir).catch(() => undefined);

    const path = `${exportDir}/${safeFilename(name)}`;
    const isText = typeof data === "string";
    await fs.writeFile(
      path,
      isText ? data : bytesToBase64(data),
      isText ? "utf8" : "base64",
    );

    await share.open({
      url: `file://${path}`,
      type: mimeType,
      // Cancelling a share sheet is a normal thing a user does, not an error.
      failOnCancel: false,
    });
  }

  /**
   * The desktop path: a file in Downloads, not a share sheet.
   *
   * Never overwrites. A browser saving the same download twice writes
   * `name (2).ext`, and silently replacing a score somebody exported an hour
   * ago is the one outcome that loses work — so this walks the suffix until it
   * finds a free name. Where `exists` is unavailable it writes the plain name,
   * because refusing to export at all is worse than the small risk.
   */
  private async saveToDownloads(
    fs: RNFSLike,
    name: string,
    data: Uint8Array | string,
  ): Promise<void> {
    const dir =
      fs.DownloadDirectoryPath ??
      fs.DocumentDirectoryPath ??
      fs.CachesDirectoryPath;
    const safe = safeFilename(name);
    const path = await freePath(fs, dir, safe);
    const isText = typeof data === "string";
    await fs.writeFile(
      path,
      isText ? data : bytesToBase64(data),
      isText ? "utf8" : "base64",
    );
  }
}

/** `dir/name`, or `dir/name (2)` and so on where that is taken. */
async function freePath(
  fs: RNFSLike,
  dir: string,
  name: string,
): Promise<string> {
  const exists = fs.exists;
  if (!exists) return `${dir}/${name}`;
  const dot = name.lastIndexOf(".");
  // A leading dot is the whole name of a hidden file, not an extension.
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? `${dir}/${name}` : `${dir}/${stem} (${n})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${dir}/${stem} (${Date.now()})${ext}`;
}
