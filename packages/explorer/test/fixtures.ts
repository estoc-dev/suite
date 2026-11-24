import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeObject, LinkValue, linkOf } from "@estoc/object";
import { link, optional, rootSchema, schema, string } from "@estoc/schema";
import { type Backend, MemoryBackend, Store } from "@estoc/store";
import { onTestFinished } from "vitest";
import { type Channel, Client, portChannel } from "../src/index.ts";
import type { List } from "../src/list.ts";
import { Runtime } from "../src/runtime.ts";

export const noteSchema = schema("Note", { text: string(), image: optional(link()) });
export const image = new TextEncoder().encode("not an object");
export const note = encodeObject(noteSchema, { text: "with an image", image: new LinkValue(linkOf(image)) });

/** What a store holds once `note` is written to it, in the order a store writes them. */
export const noteBlobs = [rootSchema.bytes, noteSchema.bytes, image, note.bytes];

export async function storeOfNote(backend: Backend = new MemoryBackend()): Promise<Store> {
  const store = new Store(backend);
  await store.write({ roots: [note.link], blobs: noteBlobs });
  return store;
}

/** The two ends of a channel, which closes once the test finishes. */
export function channelEnds(): [Channel, Channel] {
  const { port1, port2 } = new MessageChannel();
  onTestFinished(() => port1.close());
  return [portChannel(port1), portChannel(port2)];
}

export function clientOf(store: Store, lists: readonly List[] = []): Client {
  const [near, far] = channelEnds();
  new Runtime(store, lists).serve(far);
  return new Client(near);
}

export async function makeTemporaryFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "explorer-"));
  onTestFinished(() => rm(folder, { recursive: true }));
  return folder;
}
