import { type Bundle, decodeBundle } from "@estoc/bundle";
import { type Inspection, inspect } from "@estoc/inspector";
import { linkIn } from "./address.ts";
import { blobListOf, type ListedBlob } from "./blob-list.ts";
import { type FileReading, fileReadingsOf, type Reading, readingOf } from "./reading.ts";
import { readings } from "./readings.ts";

/** A file that gave no bytes, as one does that is removed after it is chosen. */
export interface ReadFailure {
  readonly kind: "unread";
  readonly name: string;
  readonly error: unknown;
}

export interface Refusal {
  readonly kind: "refused";
  readonly name: string;
  readonly error: unknown;
}

export interface OpenFile {
  readonly kind: "open";
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly bundle: Bundle;
  readonly blobs: readonly ListedBlob[];
  readonly readings: readonly FileReading[];
}

export type ShownFile = OpenFile & { readonly inspection: Inspection; readonly reading: Reading | undefined };

export type Page = { readonly kind: "closed" } | ReadFailure | Refusal | ShownFile;

/**
 * What stops the reading is given and not thrown, so that it is the page of that file as an open
 * bundle is, and takes the place of the file before it.
 */
export async function readFile(file: Pick<File, "name" | "arrayBuffer">): Promise<OpenFile | Refusal | ReadFailure> {
  const { name } = file;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    return { kind: "unread", name, error };
  }
  let bundle: Bundle;
  try {
    bundle = decodeBundle(bytes);
  } catch (error) {
    return { kind: "refused", name, error };
  }
  return { kind: "open", name, bytes, bundle, blobs: await blobListOf(bundle), readings: fileReadingsOf(readings) };
}

export async function pageOf(fileTask: ReturnType<typeof readFile> | undefined, fragment: string): Promise<Page> {
  const file = await fileTask;
  if (file === undefined) return { kind: "closed" };
  if (file.kind !== "open") return file;
  const inspection = await inspect(linkIn(fragment) ?? file.bundle.link, file.bundle);
  return { ...file, inspection, reading: await readingOf(inspection, file.bundle, file.readings) };
}
