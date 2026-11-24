import { encodeObject, type Link, LinkValue, objectsOf } from "@estoc/object";
import { array, boolean, link, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  actionOver,
  indexOver,
  MemoryBackend,
  perform,
  RefusedBatch,
  type StagedStore,
  Store,
  scan,
  selectedBlobs,
  writtenObjectSchema,
  writtenObjectsOf,
} from "../src/index.ts";

const cardSchema = schema("Card", { name: string() });
const card = (name: string) => encodeObject(cardSchema, { name });
const writtenAt = (object: { readonly link: Link<unknown> }, at: number) =>
  encodeObject(writtenObjectSchema, { object: new LinkValue(object.link), at });

const cardsByName = indexOver(selectedBlobs(objectsOf(cardSchema)), cardSchema, ({ data }) => [data]).orderedBy("name");

async function cardNamesIn(store: Store | StagedStore): Promise<string[]> {
  const names: string[] = [];
  for await (const { data } of (await scan(store, cardsByName)).range([])) names.push(data.name);
  return names;
}

async function blobsOf(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.blobs()) links.push(link);
  return links;
}

const newStore = () => new Store(new MemoryBackend());

const addCard = actionOver(
  schema("Add Card", { name: string() }),
  schema("Added Card", { card: link() }),
  async ({ name }, store) => {
    const added = card(name);
    await store.write({ roots: [added.link], blobs: [added.bytes, ...cardSchema.blobs] });
    await store.record(writtenObjectsOf([added.link], 0));
    return { card: new LinkValue(added.link) };
  },
);

const listCards = actionOver(
  schema("List Cards", {}),
  schema("Card List", { names: array(string()) }),
  async (_, store) => ({
    names: await cardNamesIn(store),
  }),
);

const draftCard = actionOver(
  schema("Draft Card", { name: string(), isKept: boolean() }),
  schema("Card Draft", { names: array(string()) }),
  async ({ name, isKept }, store) => {
    const draft = card(name);
    const stagedStore = await store.stage({ roots: [draft.link], blobs: [draft.bytes, ...cardSchema.blobs] });
    if (isKept) await stagedStore.commit();
    return { names: await cardNamesIn(stagedStore) };
  },
);

describe("an action performed on a store", () => {
  it("gives its result as an object of its result schema, which the store does not come to hold", async () => {
    const store = newStore();
    const { result } = await perform(store, addCard, { name: "ace" });
    expect(result.schema).toBe(addCard.resultSchema);
    expect(result.data).toEqual({ card: new LinkValue(card("ace").link) });
    expect(await store.get(result.link)).toBeUndefined();
    expect(await store.get(encodeObject(addCard.requestSchema, { name: "ace" }).link)).toBeUndefined();
  });

  it("gives the roots it wrote and the statements it recorded, in the order they went through", async () => {
    const store = newStore();
    const { commits } = await perform(store, addCard, { name: "ace" });
    expect(commits).toEqual([{ root: card("ace").link }, { statement: writtenAt(card("ace"), 0).link }]);
    expect(await store.get(card("ace").link)).toEqual(card("ace").bytes);
    expect((await store.recordedStatements()).statements).toEqual([writtenAt(card("ace"), 0).link]);
  });

  it("gives no commits when it only reads, and scans the store as what it is performed on is scanned", async () => {
    const store = newStore();
    await perform(store, addCard, { name: "king" });
    await perform(store, addCard, { name: "ace" });
    const blobs = await blobsOf(store);
    const { result, commits } = await perform(store, listCards, {});
    expect(result.data.names).toEqual(["ace", "king"]);
    expect(commits).toEqual([]);
    expect(await blobsOf(store)).toEqual(blobs);
  });

  it("gives the roots of a batch it staged once the batch is committed, and scans what it staged", async () => {
    const store = newStore();
    await perform(store, addCard, { name: "king" });
    const left = await perform(store, draftCard, { name: "ace", isKept: false });
    expect(left.result.data.names).toEqual(["ace", "king"]);
    expect(left.commits).toEqual([]);
    expect(await store.get(card("ace").link)).toBeUndefined();
    const kept = await perform(store, draftCard, { name: "ace", isKept: true });
    expect(kept.result.data.names).toEqual(["ace", "king"]);
    expect(kept.commits).toEqual([{ root: card("ace").link }]);
    expect(await cardNamesIn(store)).toEqual(["ace", "king"]);
  });

  it("gives the commits of a batch that adds nothing to what the store holds", async () => {
    const store = newStore();
    const first = await perform(store, addCard, { name: "ace" });
    const blobs = await blobsOf(store);
    const second = await perform(store, addCard, { name: "ace" });
    expect(second.commits).toEqual(first.commits);
    expect(await blobsOf(store)).toEqual(blobs);
  });

  it("gives no commit of a batch the store refused", async () => {
    const addAfterRefusal = actionOver(addCard.requestSchema, addCard.resultSchema, async ({ name }, store) => {
      await expect(store.write({ roots: [card("absent").link], blobs: [] })).rejects.toThrow(RefusedBatch);
      await expect(store.record({ statements: [card("absent").link], blobs: [] })).rejects.toThrow(RefusedBatch);
      const added = card(name);
      await store.write({ roots: [added.link], blobs: [added.bytes, ...cardSchema.blobs] });
      return { card: new LinkValue(added.link) };
    });
    const { commits } = await perform(newStore(), addAfterRefusal, { name: "ace" });
    expect(commits).toEqual([{ root: card("ace").link }]);
  });

  it("gives the roots and statements of batches that give them only once", async () => {
    const addTwo = actionOver(schema("Add Two Cards", {}), schema("Added Two Cards", {}), async (_, store) => {
      const cards = [card("ace"), card("king")];
      const once = function* <T>(links: readonly T[]) {
        yield* links;
      };
      await store.write({
        roots: once(cards.map(({ link }) => link)),
        blobs: [...cards.map(({ bytes }) => bytes), ...cardSchema.blobs],
      });
      const { statements, blobs } = writtenObjectsOf([card("ace").link], 0);
      await store.record({ statements: once([...statements]), blobs });
      return {};
    });
    const store = newStore();
    const { commits } = await perform(store, addTwo, {});
    expect(commits).toEqual([
      { root: card("ace").link },
      { root: card("king").link },
      { statement: writtenAt(card("ace"), 0).link },
    ]);
    expect(await cardNamesIn(store)).toEqual(["ace", "king"]);
  });

  it("gives the commits of the actions it performs itself, among its own", async () => {
    const addPair = actionOver(
      schema("Add Pair", { first: string(), second: string() }),
      schema("Added Pair", { cards: array(link()) }),
      async ({ first, second }, store) => {
        const added = await perform(store, addCard, { name: first });
        await store.record(writtenObjectsOf([added.result.data.card.link], 1));
        return { cards: [added.result.data.card, (await perform(store, addCard, { name: second })).result.data.card] };
      },
    );
    const { commits } = await perform(newStore(), addPair, { first: "ace", second: "king" });
    expect(commits).toEqual([
      { root: card("ace").link },
      { statement: writtenAt(card("ace"), 0).link },
      { statement: writtenAt(card("ace"), 1).link },
      { root: card("king").link },
      { statement: writtenAt(card("king"), 0).link },
    ]);
  });

  it("is given the environment it is performed with", async () => {
    const stampCard = actionOver(
      addCard.requestSchema,
      addCard.resultSchema,
      async ({ name }, store, { clock }: { readonly clock: () => number }) => {
        const added = card(name);
        await store.write({ roots: [added.link], blobs: [added.bytes, ...cardSchema.blobs] });
        await store.record(writtenObjectsOf([added.link], clock()));
        return { card: new LinkValue(added.link) };
      },
    );
    const store = newStore();
    const { commits } = await perform(store, stampCard, { name: "ace" }, { clock: () => 7 });
    expect(commits).toEqual([{ root: card("ace").link }, { statement: writtenAt(card("ace"), 7).link }]);
    // @ts-expect-error the action is given a clock
    await expect(perform(store, stampCard, { name: "ace" })).rejects.toThrow(TypeError);
  });

  it("fails as it throws, and leaves in the store what it committed before", async () => {
    const failure = new Error("the second card is not added");
    const addThenFail = actionOver(addCard.requestSchema, addCard.resultSchema, async (request, store) => {
      await perform(store, addCard, request);
      throw failure;
    });
    const store = newStore();
    await expect(perform(store, addThenFail, { name: "ace" })).rejects.toBe(failure);
    expect(await cardNamesIn(store)).toEqual(["ace"]);
  });

  it("is not performed on a store not made by `new Store`", async () => {
    const store = newStore();
    const lookalike: Store = {
      get: <T>(link: Link<T>) => store.get(link),
      write: (batch) => store.write(batch),
      stage: (batch) => store.stage(batch),
      record: (batch) => store.record(batch),
      blobs: () => store.blobs(),
      records: () => store.records(),
      recordedStatements: () => store.recordedStatements(),
      closure: (link) => store.closure(link),
    };
    await expect(perform(lookalike, addCard, { name: "ace" })).rejects.toThrow(TypeError);
    expect(await blobsOf(store)).toEqual([]);
  });
});
