import type { FileExporter } from "@sudobility/music_types";
import { bytesToBase64 } from "@sudobility/music_types";

/** The subset of `react-native-fs` this needs, structural so a test can stand in for it. */
type RNFSLike = {
  CachesDirectoryPath: string;
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
  loadModules?: () => Promise<{ fs: RNFSLike; share: RNShareLike }>;
  makeExportId?: () => string;
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
  share: RNShareLike;
}> {
  const [fsModule, shareModule] = await Promise.all([
    import("react-native-fs"),
    import("react-native-share"),
  ]);
  const fs = ((fsModule as { default?: unknown }).default ??
    fsModule) as RNFSLike;
  const share = ((shareModule as { default?: unknown }).default ??
    shareModule) as RNShareLike;
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
    const { fs, share } = await (this.deps.loadModules ?? defaultLoadModules)();

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
}
