import { ed25519, identityKit } from "@estoc/identity";
import { generateKey } from "@estoc/keyring";
import {
  decodeObject,
  type EncodedObject,
  encodeObject,
  LinkValue,
  linkOf,
  readObject,
  type ValueMap,
} from "@estoc/object";
import { type DataOf, integer, link, schema, string } from "@estoc/schema";
import { actionOver, MemoryBackend, Store } from "@estoc/store";
import { assert, describe, expect, it } from "vitest";
import { listedAction } from "../src/action.ts";
import { Runtime, recordedStatementSchema } from "../src/runtime.ts";
import { clientOf, image, note, noteSchema, storeOfNote } from "./fixtures.ts";

const { secretKeys } = identityKit;

const annotatedSchema = schema("Annotated", { annotation: link() });

/** Writes a note of `text` whose image is the note it is given. */
const annotate = actionOver(
  schema("Annotate", { note: link<EncodedObject<DataOf<typeof noteSchema>>>(), text: string() }),
  annotatedSchema,
  async ({ note: annotated, text }, store) => {
    const annotation = encodeObject(noteSchema, { text, image: new LinkValue(annotated.link) });
    await store.write({ roots: [annotation.link], blobs: [annotation.bytes] });
    return { annotation: new LinkValue(annotation.link) };
  },
).taking("note", noteSchema);

const lateNote = encodeObject(noteSchema, { text: "written before it failed" });

const writeThenFail = actionOver(schema("Write Then Fail", {}), schema("Nothing", {}), async (_, store) => {
  await store.write({ roots: [lateNote.link], blobs: [lateNote.bytes, ...noteSchema.blobs] });
  throw new Error("the action failed after it wrote");
});

const tellTime = actionOver(
  schema("Tell Time", {}),
  schema("Time", { at: integer() }),
  (_, __, { clock }: { readonly clock: () => number }) => ({ at: clock() }),
);

const emptyStore = () => new Store(new MemoryBackend());

describe("a client of a runtime that is given actions", () => {
  it("lists them in the order given, each by the schemas of its request and its result and of what its fields take", async () => {
    const client = clientOf(emptyStore(), [], [listedAction(annotate, {}), listedAction(generateKey, {})]);
    expect((await client.actions()).map(({ data }) => data)).toEqual([
      {
        request: new LinkValue(annotate.requestSchema.link),
        result: new LinkValue(annotatedSchema.link),
        targetSchemas: { note: new LinkValue(noteSchema.link) },
      },
      {
        request: new LinkValue(generateKey.requestSchema.link),
        result: new LinkValue(generateKey.resultSchema.link),
        targetSchemas: {},
      },
    ]);
  });

  it("lists none where the runtime is given none", async () => {
    expect(await clientOf(emptyStore()).actions()).toEqual([]);
  });

  it("reads the schemas of their requests and results and of what their fields take, though the store does not hold them", async () => {
    const store = emptyStore();
    const client = clientOf(store, [], [listedAction(annotate, {})]);
    for (const shownSchema of [annotate.requestSchema, annotatedSchema, noteSchema]) {
      expect(await store.get(shownSchema.link)).toBeUndefined();
      expect(await client.get(shownSchema.link)).toEqual(shownSchema.bytes);
    }
  });

  it("performs the action that the schema of a request names, and reads its result and what it committed", async () => {
    const store = emptyStore();
    const client = clientOf(store, [], [listedAction(annotate, {}), listedAction(generateKey, {})]);
    const request = encodeObject(generateKey.requestSchema, { scheme: ed25519.name });

    const { result, commits } = await client.perform(request.bytes);
    const { key } = decodeObject(result, generateKey.resultSchema).data;
    expect(commits).toHaveLength(1);
    const [secretKey] = commits;
    assert.exists(secretKey);
    expect((await readObject(client, secretKey, secretKeys.schema)).data.key.link).toBe(key.link);
    const records = await client.page("Records", 0, 10);
    expect(records.rows.map((bytes) => decodeObject(bytes, recordedStatementSchema).data.statement.link)).toEqual(
      commits,
    );
    expect(await store.get(request.link)).toBeUndefined();
    expect(await store.get(linkOf(result))).toBeUndefined();
  });

  it("performs an action on the objects that the links of its request are to", async () => {
    const client = clientOf(await storeOfNote(), [], [listedAction(annotate, {})]);
    const request = encodeObject(annotate.requestSchema, { note: new LinkValue(note.link), text: "seen" });

    const { result, commits } = await client.perform(request.bytes);
    const { annotation } = decodeObject(result, annotatedSchema).data;
    expect(commits).toEqual([annotation.link]);
    expect((await readObject(client, annotation.link, noteSchema)).data).toEqual({
      text: "seen",
      image: new LinkValue(note.link),
    });
  });

  it("performs an action in the environment it was listed with", async () => {
    const client = clientOf(emptyStore(), [], [listedAction(tellTime, { clock: () => 9_000 })]);
    const { result, commits } = await client.perform(encodeObject(tellTime.requestSchema, {}).bytes);
    expect(decodeObject(result, tellTime.resultSchema).data).toEqual({ at: 9_000 });
    expect(commits).toEqual([]);
  });

  it("is told why an action failed, and reads what the action wrote before it did", async () => {
    const client = clientOf(emptyStore(), [], [listedAction(writeThenFail, {})]);
    const request = encodeObject(writeThenFail.requestSchema, {});
    await expect(client.perform(request.bytes)).rejects.toThrow("the action failed after it wrote");
    expect(await client.get(lateNote.link)).toEqual(lateNote.bytes);
  });

  it("is refused a request whose link is to an object of another schema than its field takes, and nothing is written", async () => {
    const store = await storeOfNote();
    const client = clientOf(store, [], [listedAction(annotate, {})]);
    // A page writes a request with no types in hand, so a link of it can be to anything.
    const request = encodeObject<ValueMap>(annotate.requestSchema, {
      note: new LinkValue(noteSchema.link),
      text: "seen",
    });
    await expect(client.perform(request.bytes)).rejects.toThrow(`not to ${noteSchema.link}`);
    expect((await client.page("Blobs", 0, 10)).blobCount).toBe(4);
  });

  it("is refused a request written to a schema that no action takes", async () => {
    const client = clientOf(await storeOfNote(), [], [listedAction(annotate, {})]);
    await expect(client.perform(note.bytes)).rejects.toThrow(`no action takes a request written to ${noteSchema.link}`);
  });

  it("is refused a request that is not an object, and is answered after it", async () => {
    const client = clientOf(emptyStore(), [], [listedAction(annotate, {})]);
    await expect(client.perform(image)).rejects.toThrow();
    expect(await client.actions()).toHaveLength(1);
  });
});

describe("a runtime", () => {
  it("is not made with two actions that take requests of one schema", () => {
    const actions = [listedAction(annotate, {}), listedAction(annotate, {})];
    expect(() => new Runtime(emptyStore(), [], actions)).toThrow(
      `two actions take a request written to ${annotate.requestSchema.link}`,
    );
  });
});
