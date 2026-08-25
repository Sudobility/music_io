import type { FileExporter } from "@sudobility/music_types";

/**
 * Object URL plus a synthetic anchor click — the standard browser download
 * dance, in one place so every export call site shares it.
 */
export class WebFileExporter implements FileExporter {
  async save(
    name: string,
    data: Uint8Array | string,
    mimeType: string,
  ): Promise<void> {
    const blob = new Blob([data as BlobPart], { type: mimeType });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    } finally {
      // Always released: a leaked object URL pins its blob in memory for the
      // life of the page.
      URL.revokeObjectURL(url);
    }
  }
}
