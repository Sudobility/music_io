import type { FileExporter } from '@sudobility/music_types';

/**
 * Writes the file to the app's cache directory, then opens the system share
 * sheet — React Native's equivalent of a browser download, since there is no
 * filesystem the user browses directly.
 *
 * `react-native-fs` and `react-native-share` are imported lazily so that merely
 * loading this module on a machine without them (the test runner, a Node
 * script) does not throw. Only `save()` needs them.
 */
export class RNFileExporter implements FileExporter {
  async save(name: string, data: Uint8Array | string, mimeType: string): Promise<void> {
    const [fsModule, shareModule] = await Promise.all([
      import('react-native-fs'),
      import('react-native-share'),
    ]);
    const fs = (fsModule as { default?: unknown }).default ?? fsModule;
    const share = (shareModule as { default?: unknown }).default ?? shareModule;

    const { CachesDirectoryPath, writeFile } = fs as {
      CachesDirectoryPath: string;
      writeFile: (path: string, contents: string, encoding: string) => Promise<void>;
    };

    const path = `${CachesDirectoryPath}/${name}`;
    const isText = typeof data === 'string';
    await writeFile(path, isText ? data : toBase64(data), isText ? 'utf8' : 'base64');

    await (share as { open: (options: Record<string, unknown>) => Promise<unknown> }).open({
      url: `file://${path}`,
      type: mimeType,
      // Cancelling a share sheet is a normal thing a user does, not an error.
      failOnCancel: false,
    });
  }
}

/** Base64 without assuming Node's Buffer, which React Native does not ship. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return typeof btoa === 'function'
    ? btoa(binary)
    : (globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } })
        .Buffer!.from(binary, 'binary')
        .toString('base64');
}
