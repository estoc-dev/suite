import { readBundle, writeBundle } from "@estoc/bundle";
import { ed25519, loadIdentity, noVersions, SoftwareSigner } from "@estoc/identity";
import { encodeObject, encodeSchema, json, type Link, readObject, schemaOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { catalog, MemoryBackend, Store, view } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { loadComments } from "../src/index.ts";

// Applications that treat a store as a database of hashes: what the user
// wrote, listed by the schema each object names; what a hash holds; and
// comments on any hash, which travel with what they are on.

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const titled = (title: string) =>
  encodeSchema(
    { $schema: DRAFT, title, type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    defaultValidator,
  );
const [note, task] = await Promise.all([titled("Note"), titled("Task")]);
const comments = await loadComments({ validator: defaultValidator });
const { signatures, publish } = await loadIdentity(defaultValidator);
const alice = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));

async function all<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("a viewer of the user's hashes", () => {
  it("lists them by schema, shows what one holds, and comments on it", async () => {
    const store = new Store(json, new MemoryBackend());
    const lunch = encodeObject(note, { text: "lunch at noon" });
    const dinner = encodeObject(note, { text: "dinner at eight" });
    const call = encodeObject(task, { text: "call the bakery" });
    await store.write({ mine: [lunch, dinner, call], blobs: [note.bytes, task.bytes] });

    // The schemas the user's objects name, and the objects of one of them.
    const rows = await catalog(store, json);
    const named = new Set((await all(rows.range([]))).map(([schema]) => schema));
    expect(named).toEqual(new Set([note.link, task.link]));
    const notes = (await all(rows.range([note.link]))).map(([, object]) => object);
    expect(notes).toEqual([lunch.link, dinner.link].sort());

    // What a hash holds, read without knowing its schema, and its schema read as one too.
    const bytes = await store.get(lunch.link);
    expect(bytes && json.decode(bytes)).toEqual({ $describedBy: { $link: note.link }, text: "lunch at noon" });
    const schema = bytes && (await store.get(schemaOf(bytes, json)));
    expect(schema && json.decode(schema)).toMatchObject({ title: "Note" });

    // A comment on it, and one on the schema.
    await comments.write(store, lunch.link, "noon is too early");
    await comments.write(store, note.link, "a note has text");
    const commentary = await view(store, comments.view);
    expect((await commentary.on(lunch.link)).map(({ text }) => text)).toEqual(["noon is too early"]);
    expect(await all(commentary.commented())).toEqual([lunch.link, note.link].sort());

    // The comments are objects the user wrote too, listed under their own schema.
    const after = await catalog(store, json);
    expect(await all(after.range([comments.schema.link]))).toHaveLength(2);
  });
});

describe("a signed comment", () => {
  it("travels in a bundle with what it is on, and reads with who wrote it", async () => {
    const store = new Store(json, new MemoryBackend());
    const lunch = encodeObject(note, { text: "lunch at noon" });
    await store.write({ mine: [lunch], blobs: [note.bytes] });
    const comment = await comments.write(store, lunch.link, "noon is too early");
    const signature = await signatures.actor(alice, await publish(alice, 0)).sign(comment);
    await store.write({ mine: [signature], blobs: [...signature.signedIdentity.blobs, signatures.schema.bytes] });

    const bundle = readBundle(writeBundle(signature, (await store.closure(signature.link)).values()));
    const read = await signatures.read(bundle.link, bundle, noVersions);
    expect(read.signedIdentity.identity.root.link).toBe(signature.signedIdentity.identity.root.link);
    const received = await comments.read(read.object, bundle);
    expect(received).toEqual(comment);
    const on: Link<unknown> = received.on;
    expect((await readObject(bundle, on, note)).data).toEqual({ text: "lunch at noon" });
  });
});
