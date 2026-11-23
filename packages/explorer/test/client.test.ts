import { decodeObject, encodeObject, LinkValue, linkOf, type ValueMap } from "@estoc/object";
import { rootSchema } from "@estoc/schema";
import { type Backend, MemoryBackend } from "@estoc/store";
import { assert, describe, expect, it, onTestFinished } from "vitest";
import { callSchema, replySchema } from "../src/calls.ts";
import { type Channel, Client } from "../src/index.ts";
import { heldBlobSchema, Runtime } from "../src/runtime.ts";
import { channelEnds, clientOf, image, note, noteBlobs, noteSchema, storeOfNote } from "./fixtures.ts";

const heldBlobsIn = (rows: readonly Uint8Array[]) => rows.map((bytes) => decodeObject(bytes, heldBlobSchema).data);

function answerEach(far: Channel, resultOf: (name: string) => ValueMap): void {
  far.receive(
    (message) => {
      const { id, name } = decodeObject(message, callSchema).data;
      far.send(encodeObject(replySchema, { id, result: resultOf(name) }).bytes);
    },
    () => {},
  );
}

describe("a client of a runtime", () => {
  it("reads a blob the store holds, and nothing under a link it does not hold", async () => {
    const client = clientOf(await storeOfNote());
    expect(await client.get(note.link)).toEqual(note.bytes);
    expect(await client.get(linkOf(image))).toEqual(image);
    expect(await client.get(linkOf(new Uint8Array([1])))).toBeUndefined();
  });

  it("lists Blobs, whose rows are written to a schema that it reads though the store does not hold it", async () => {
    const store = await storeOfNote();
    const client = clientOf(store);
    const [blobs, ...others] = await client.lists();
    assert.exists(blobs);
    expect(others).toEqual([]);
    expect(blobs.data).toEqual({
      name: "Blobs",
      rows: new LinkValue(heldBlobSchema.link),
      order: [],
      readsBlobs: true,
    });
    expect(await store.get(heldBlobSchema.link)).toBeUndefined();
    expect(await client.get(heldBlobSchema.link)).toEqual(heldBlobSchema.bytes);
  });

  it("reads a page of Blobs as a row for each blob, in the order written, with its size and the schema it names", async () => {
    const client = clientOf(await storeOfNote());
    const page = await client.page("Blobs", 0, 10);
    expect(page).toMatchObject({ start: 0, rowCount: 4, blobCount: 4 });
    expect(heldBlobsIn(page.rows)).toEqual([
      { blob: new LinkValue(rootSchema.link), size: rootSchema.bytes.length, schema: new LinkValue(rootSchema.link) },
      { blob: new LinkValue(noteSchema.link), size: noteSchema.bytes.length, schema: new LinkValue(rootSchema.link) },
      { blob: new LinkValue(linkOf(image)), size: image.length },
      { blob: new LinkValue(note.link), size: note.bytes.length, schema: new LinkValue(noteSchema.link) },
    ]);
  });

  it.each([
    ["from where it starts, up to its limit", 1, 2, 1, [1, 2]],
    ["up to the end of the list where its limit goes past", 3, 10, 3, [3]],
    ["counted from the end where its start is below zero", -2, 10, 2, [2, 3]],
    ["from the front where its start is further below zero than the list is long", -10, 2, 0, [0, 1]],
    ["of no rows at the end of the list where its start is past the end", 9, 2, 4, []],
    ["of no rows where its limit is below one", 1, -1, 1, []],
  ])("reads a page %s", async (_, start, limit, pageStart, blobs) => {
    const client = clientOf(await storeOfNote());
    const page = await client.page("Blobs", start, limit);
    expect(page).toMatchObject({ start: pageStart, rowCount: 4, blobCount: 4 });
    const links = noteBlobs.map((bytes) => linkOf(bytes));
    expect(heldBlobsIn(page.rows).map(({ blob }) => blob.link)).toEqual(blobs.map((at) => links[at]));
  });

  it("reads a page with the blobs written since the one before", async () => {
    const store = await storeOfNote();
    const client = clientOf(store);
    expect(await client.page("Blobs", -1, 1)).toMatchObject({ start: 3, blobCount: 4 });
    const later = encodeObject(noteSchema, { text: "written later" });
    await store.write({ roots: [later.link], blobs: [later.bytes] });
    const page = await client.page("Blobs", -1, 1);
    expect(page).toMatchObject({ start: 4, rowCount: 5, blobCount: 5 });
    expect(heldBlobsIn(page.rows)).toMatchObject([{ blob: new LinkValue(later.link) }]);
  });

  it("fails a call with the reason the runtime gives", async () => {
    const client = clientOf(await storeOfNote());
    await expect(client.page("Nothing", 0, 1)).rejects.toThrow("there is no list named Nothing");
  });

  it("receives a later reply while the first call is still pending", async () => {
    const backend = new MemoryBackend();
    let giveNote = () => {};
    const noteIsGiven = new Promise<void>((resolve) => {
      giveNote = resolve;
    });
    const slowBackend: Backend = {
      async get(link) {
        if (link === note.link) await noteIsGiven;
        return backend.get(link);
      },
      has: (link) => backend.has(link),
      put: (blobs) => backend.put(blobs),
      blobs: (start) => backend.blobs(start),
    };
    const client = clientOf(await storeOfNote(slowBackend));
    const slowRead = client.get(note.link);
    expect(await client.get(linkOf(image))).toEqual(image);
    giveNote();
    expect(await slowRead).toEqual(note.bytes);
  });

  it("refuses a blob that is not the one the link names", async () => {
    const [near, far] = channelEnds();
    answerEach(far, () => ({ bytes: image }));
    await expect(new Client(near).get(note.link)).rejects.toThrow(`the blob given for ${note.link} is another blob`);
  });

  it("refuses a result that does not fit its call", async () => {
    const [near, far] = channelEnds();
    answerEach(far, () => ({ rows: [] }));
    await expect(new Client(near).page("Blobs", 0, 1)).rejects.toThrow("#/start: left out");
  });

  it.each([
    ["its own end", 0],
    ["the far end", 1],
  ])("fails the calls that wait when %s of the channel closes, and those made after", async (_, closing) => {
    const ends = channelEnds();
    const client = new Client(ends[0]);
    const read = client.get(note.link);
    ends[closing]?.close();
    await expect(read).rejects.toThrow("the channel closed before the reply");
    await expect(client.lists()).rejects.toThrow("the channel is closed");
  });

  it("fails a call that cannot be written, and leaves nothing of it to fail when the channel closes", async () => {
    const [near, far] = channelEnds();
    const client = new Client(near);
    const unhandledRejections: unknown[] = [];
    const keep = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", keep);
    onTestFinished(() => void process.off("unhandledRejection", keep));
    await expect(client.page("Blobs", 0.5, 1)).rejects.toThrow("a number is an integer");
    const read = client.get(note.link);
    far.close();
    await expect(read).rejects.toThrow("the channel closed before the reply");
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandledRejections).toEqual([]);
  });
});

describe("a runtime", () => {
  async function replyTo(call: ValueMap) {
    const [near, far] = channelEnds();
    new Runtime(await storeOfNote()).serve(far);
    return new Promise<ValueMap>((resolve) => {
      near.receive(
        (message) => resolve(decodeObject(message, replySchema).data),
        () => {},
      );
      near.send(encodeObject(callSchema, call).bytes);
    });
  }

  it.each([
    ["of a name it does not answer", { id: 7, name: "nothing", parameters: {} }, "there is no call named nothing"],
    ["whose parameters are not a map", { id: 7, name: "lists", parameters: 1 }, "the parameters of a call are a map"],
    ["whose parameters do not fit it", { id: 7, name: "blob", parameters: {} }, "#/link: left out"],
  ])("answers a call %s with why it failed", async (_, call, reason) => {
    expect(await replyTo(call)).toEqual({ id: 7, error: expect.stringContaining(reason) });
  });

  it("closes a channel that brings what is not a call", async () => {
    const [near, far] = channelEnds();
    new Runtime(await storeOfNote()).serve(far);
    const isClosed = new Promise<void>((resolve) => near.receive(() => {}, resolve));
    near.send(note.bytes);
    await isClosed;
  });
});
