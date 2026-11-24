import { runInNewContext } from "node:vm";
import { type EncodedObject, encodeObject, type Link, LinkValue, objectsOf } from "@estoc/object";
import { array, boolean, type DataOf, integer, link, schema, string } from "@estoc/schema";
import { assert, describe, expect, it, test } from "vitest";
import {
  actionOver,
  indexOver,
  MemoryBackend,
  perform,
  RefusedBatch,
  type StagedStore,
  Store,
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
  for await (const { data } of (await store.scan(cardsByName)).range([])) names.push(data.name);
  return names;
}

async function blobsOf(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.blobs()) links.push(link);
  return links;
}

const newStore = () => new Store(new MemoryBackend());

const OtherRealmPromise = runInNewContext("Promise") as PromiseConstructor;

const noBatchAfterAnswer = "the store given to an action takes no batch after the action answered";

const addCard = actionOver(
  schema("Add Card", { name: string() }),
  schema("Added Card", { card: link() }),
  async ({ name }, store) => {
    const addedCard = card(name);
    await store.write({ roots: [addedCard.link], blobs: [addedCard.bytes, ...cardSchema.blobs] });
    await store.record(writtenObjectsOf([addedCard.link], 0));
    return { card: new LinkValue(addedCard.link) };
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
    expect(commits).toEqual([card("ace").link, writtenAt(card("ace"), 0).link]);
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
    const discardedDraft = await perform(store, draftCard, { name: "ace", isKept: false });
    expect(discardedDraft.result.data.names).toEqual(["ace", "king"]);
    expect(discardedDraft.commits).toEqual([]);
    expect(await store.get(card("ace").link)).toBeUndefined();
    const keptDraft = await perform(store, draftCard, { name: "ace", isKept: true });
    expect(keptDraft.result.data.names).toEqual(["ace", "king"]);
    expect(keptDraft.commits).toEqual([card("ace").link]);
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
      const addedCard = card(name);
      await store.write({ roots: [addedCard.link], blobs: [addedCard.bytes, ...cardSchema.blobs] });
      return { card: new LinkValue(addedCard.link) };
    });
    const { commits } = await perform(newStore(), addAfterRefusal, { name: "ace" });
    expect(commits).toEqual([card("ace").link]);
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
    expect(commits).toEqual([card("ace").link, card("king").link, writtenAt(card("ace"), 0).link]);
    expect(await cardNamesIn(store)).toEqual(["ace", "king"]);
  });

  it("gives every root of a batch with more roots than a call takes arguments", async () => {
    const roots = new Array<Link<unknown>>(150_000).fill(card("ace").link);
    const addMany = actionOver(schema("Add Many Cards", {}), schema("Added Many Cards", {}), async (_, store) => {
      await store.write({ roots, blobs: [card("ace").bytes, ...cardSchema.blobs] });
      return {};
    });
    const { commits } = await perform(newStore(), addMany, {});
    expect(commits).toEqual(roots);
  });

  it("gives the commits of batches under way at once, in either order", async () => {
    const addBoth = actionOver(schema("Add Both Cards", {}), schema("Added Both Cards", {}), async (_, store) => {
      const stagedStore = await store.stage({
        roots: [card("king").link],
        blobs: [card("king").bytes, ...cardSchema.blobs],
      });
      const { statements, blobs } = writtenObjectsOf([card("ace").link], 0);
      await Promise.all([
        store.record({ statements, blobs: [...blobs, card("ace").bytes, ...cardSchema.blobs] }),
        stagedStore.commit(),
      ]);
      return {};
    });
    const { commits } = await perform(newStore(), addBoth, {});
    expect(commits).toHaveLength(2);
    expect(commits).toEqual(expect.arrayContaining([card("king").link, writtenAt(card("ace"), 0).link]));
  });

  it("gives the commits of a batch it began and did not wait for", async () => {
    const batchesUnderWay: Promise<void>[] = [];
    const addWithoutWaiting = actionOver(addCard.requestSchema, addCard.resultSchema, ({ name }, store) => {
      const addedCard = card(name);
      batchesUnderWay.push(store.write({ roots: [addedCard.link], blobs: [addedCard.bytes, ...cardSchema.blobs] }));
      return { card: new LinkValue(addedCard.link) };
    });
    const store = newStore();
    const { commits } = await perform(store, addWithoutWaiting, { name: "ace" });
    expect(commits).toEqual([card("ace").link]);
    expect(await cardNamesIn(store)).toEqual(["ace"]);
    await Promise.all(batchesUnderWay);
  });

  it("gives the commits of the batch under way when it answered, and refuses the batch begun when that went through", async () => {
    const followUps: Promise<unknown>[] = [];
    const addThenRecord = actionOver(addCard.requestSchema, addCard.resultSchema, ({ name }, store) => {
      const addedCard = card(name);
      followUps.push(
        store
          .write({ roots: [addedCard.link], blobs: [addedCard.bytes, ...cardSchema.blobs] })
          .then(() => store.record(writtenObjectsOf([addedCard.link], 0)))
          .catch((error: unknown) => error),
      );
      return { card: new LinkValue(addedCard.link) };
    });
    const store = newStore();
    const { commits } = await perform(store, addThenRecord, { name: "ace" });
    expect(commits).toEqual([card("ace").link]);
    expect(await Promise.all(followUps)).toEqual([new Error(noBatchAfterAnswer)]);
    expect(await cardNamesIn(store)).toEqual(["ace"]);
    expect((await store.recordedStatements()).statements).toEqual([]);
  });

  it("gives the commits of a batch begun on its store before `perform` took its answer, and refuses one begun after", async () => {
    const storesGiven: Store[] = [];
    const keepStore = actionOver(schema("Keep Store", {}), schema("Kept Store", {}), (_, store) => {
      storesGiven.push(store);
      return {};
    });
    const store = newStore();
    const outcome = perform(store, keepStore, {});
    const [storeGiven] = storesGiven;
    assert.exists(storeGiven);
    await storeGiven.write({ roots: [card("ace").link], blobs: [card("ace").bytes, ...cardSchema.blobs] });
    expect((await outcome).commits).toEqual([card("ace").link]);
    await expect(
      storeGiven.write({ roots: [card("king").link], blobs: [card("king").bytes, ...cardSchema.blobs] }),
    ).rejects.toThrow(noBatchAfterAnswer);
    expect(await cardNamesIn(store)).toEqual(["ace"]);
  });

  it("answers as the promise it returned is fulfilled, when the promise is of another realm", async () => {
    const addInOtherRealm = actionOver(addCard.requestSchema, addCard.resultSchema, ({ name }, store) =>
      OtherRealmPromise.resolve().then(async () => {
        const addedCard = card(name);
        await store.write({ roots: [addedCard.link], blobs: [addedCard.bytes, ...cardSchema.blobs] });
        return { card: new LinkValue(addedCard.link) };
      }),
    );
    const store = newStore();
    const { result, commits } = await perform(store, addInOtherRealm, { name: "ace" });
    expect(result.data).toEqual({ card: new LinkValue(card("ace").link) });
    expect(commits).toEqual([card("ace").link]);
    expect(await cardNamesIn(store)).toEqual(["ace"]);
  });

  it("fails as the promise it returned is rejected, when the promise is of another realm", async () => {
    const failure = new Error("no card is added");
    const failInOtherRealm = actionOver(schema("Fail", {}), schema("Failed", {}), () =>
      OtherRealmPromise.reject(failure),
    );
    await expect(perform(newStore(), failInOtherRealm, {})).rejects.toBe(failure);
  });

  it("refuses a batch begun on its store, and the commit of what it staged, after its promise was fulfilled", async () => {
    const storesGiven: Store[] = [];
    const stagedStoresGiven: StagedStore[] = [];
    const keepStores = actionOver(schema("Keep Stores", {}), schema("Kept Stores", {}), async (_, store) => {
      storesGiven.push(store);
      stagedStoresGiven.push(
        await store.stage({ roots: [card("ace").link], blobs: [card("ace").bytes, ...cardSchema.blobs] }),
      );
      return {};
    });
    const store = newStore();
    const { commits } = await perform(store, keepStores, {});
    const [storeGiven] = storesGiven;
    const [stagedStoreGiven] = stagedStoresGiven;
    assert.exists(storeGiven);
    assert.exists(stagedStoreGiven);
    await expect(storeGiven.record({ statements: [], blobs: [] })).rejects.toThrow(noBatchAfterAnswer);
    await expect(stagedStoreGiven.commit()).rejects.toThrow(noBatchAfterAnswer);
    expect(await cardNamesIn(storeGiven)).toEqual([]);
    expect(commits).toEqual([]);
    expect(await blobsOf(store)).toEqual([]);
  });

  it("is not run with a request its request schema refuses", async () => {
    const store = newStore();
    const request = { name: "ace", suit: "spades" };
    await expect(perform(store, addCard, request)).rejects.toThrow("does not fit its schema");
    expect(await blobsOf(store)).toEqual([]);
  });

  it("gives the commits of the actions it performs itself, among its own", async () => {
    const addPair = actionOver(
      schema("Add Pair", { first: string(), second: string() }),
      schema("Added Pair", { cards: array(link()) }),
      async ({ first, second }, store) => {
        const firstOutcome = await perform(store, addCard, { name: first });
        const firstCard = firstOutcome.result.data.card;
        await store.record(writtenObjectsOf([firstCard.link], 1));
        const secondOutcome = await perform(store, addCard, { name: second });
        return { cards: [firstCard, secondOutcome.result.data.card] };
      },
    );
    const { commits } = await perform(newStore(), addPair, { first: "ace", second: "king" });
    expect(commits).toEqual([
      card("ace").link,
      writtenAt(card("ace"), 0).link,
      writtenAt(card("ace"), 1).link,
      card("king").link,
      writtenAt(card("king"), 0).link,
    ]);
  });

  it("is given the environment it is performed with", async () => {
    const stampCard = actionOver(
      addCard.requestSchema,
      addCard.resultSchema,
      async ({ name }, store, { clock }: { readonly clock: () => number }) => {
        const addedCard = card(name);
        await store.write({ roots: [addedCard.link], blobs: [addedCard.bytes, ...cardSchema.blobs] });
        await store.record(writtenObjectsOf([addedCard.link], clock()));
        return { card: new LinkValue(addedCard.link) };
      },
    );
    const store = newStore();
    const { commits } = await perform(store, stampCard, { name: "ace" }, { clock: () => 7 });
    expect(commits).toEqual([card("ace").link, writtenAt(card("ace"), 7).link]);
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

  it("refuses a batch begun on its store after it threw", async () => {
    const storesGiven: Store[] = [];
    const failure = new Error("no card is added");
    const keepStoreAndFail = actionOver(schema("Keep Store And Fail", {}), schema("Kept Store", {}), (_, store) => {
      storesGiven.push(store);
      throw failure;
    });
    const store = newStore();
    await expect(perform(store, keepStoreAndFail, {})).rejects.toBe(failure);
    const [storeGiven] = storesGiven;
    assert.exists(storeGiven);
    await expect(
      storeGiven.write({ roots: [card("ace").link], blobs: [card("ace").bytes, ...cardSchema.blobs] }),
    ).rejects.toThrow(noBatchAfterAnswer);
    expect(await blobsOf(store)).toEqual([]);
  });
});

type Card = EncodedObject<DataOf<typeof cardSchema>>;

const dealOfAnything = actionOver(
  schema("Deal", { top: link<Card>(), rest: array(link<Card>()), to: link() }),
  schema("Dealt Hand", { size: integer() }),
  async ({ top, rest }, store) => {
    await store.record(writtenObjectsOf([top.link], 0));
    return { size: 1 + rest.length };
  },
);
const deal = dealOfAnything.taking("top", cardSchema).taking("rest", cardSchema);

const jokerSchema = schema("Joker", { name: string() });
const joker = encodeObject(jokerSchema, { name: "joker" });
const unheldLink = card("unheld").link;

async function storeOfCards(): Promise<Store> {
  const store = newStore();
  const cards = [card("ace"), card("king"), card("queen")];
  await store.write({
    roots: [...cards.map(({ link }) => link), joker.link],
    blobs: [...cards.map(({ bytes }) => bytes), ...cardSchema.blobs, joker.bytes, ...jokerSchema.blobs],
  });
  return store;
}

const linkTo = (object: { readonly link: Link<unknown> }) => new LinkValue(object.link);

describe("an action taking objects of one schema in a field of its request", () => {
  it("says the schema each such field takes, and none for the other fields", () => {
    expect(deal.targetSchemas).toEqual({ top: cardSchema, rest: cardSchema });
    expect(addCard.targetSchemas).toEqual({});
  });

  it("leaves the target schemas of the action it is made from as they were", () => {
    const dealOfTop = dealOfAnything.taking("top", cardSchema);
    dealOfTop.taking("rest", cardSchema);
    expect(dealOfTop.targetSchemas).toEqual({ top: cardSchema });
    expect(dealOfAnything.targetSchemas).toEqual({});
  });

  it("is run with a request that links in those fields to objects of the schema, and in another field to anything", async () => {
    const store = await storeOfCards();
    const request = deal.requestSchema.validate({
      top: linkTo(card("ace")),
      rest: [linkTo(card("king")), linkTo(card("queen"))],
      to: new LinkValue(unheldLink),
    });
    const { result, commits } = await perform(store, deal, request);
    expect(result.data).toEqual({ size: 3 });
    expect(commits).toEqual([writtenAt(card("ace"), 0).link]);
  });

  it("is not run with a request that links in such a field to an object of another schema", async () => {
    const store = await storeOfCards();
    const request = deal.requestSchema.validate({ top: linkTo(joker), rest: [], to: linkTo(joker) });
    await expect(perform(store, deal, request)).rejects.toThrow(
      `the object is written to ${jokerSchema.link}, not to ${cardSchema.link}`,
    );
    expect((await store.recordedStatements()).statements).toEqual([]);
  });

  it("is not run with a request one of whose links in such a field is to an object of another schema", async () => {
    const store = await storeOfCards();
    const request = deal.requestSchema.validate({
      top: linkTo(card("ace")),
      rest: [linkTo(card("king")), linkTo(joker)],
      to: linkTo(joker),
    });
    await expect(perform(store, deal, request)).rejects.toThrow(
      `the object is written to ${jokerSchema.link}, not to ${cardSchema.link}`,
    );
    expect((await store.recordedStatements()).statements).toEqual([]);
  });

  it("is not run with a request that links in such a field to what the store does not hold", async () => {
    const store = await storeOfCards();
    const request = deal.requestSchema.validate({ top: new LinkValue(unheldLink), rest: [], to: linkTo(joker) });
    await expect(perform(store, deal, request)).rejects.toThrow(`no blob is given for ${unheldLink}`);
    expect((await store.recordedStatements()).statements).toEqual([]);
  });

  test("`taking` is given, for a field, no other schema than the one its links are typed to", () => {
    // @ts-expect-error The links of `top` are typed to a Card.
    deal.taking("top", writtenObjectSchema);
    // @ts-expect-error The link of `to` is typed to anything, so no one schema is said for it.
    deal.taking("to", cardSchema);
  });

  test("`taking` is given no field that the request does not have", () => {
    // @ts-expect-error The request of `listCards` has no field.
    listCards.taking("top", cardSchema);
    // @ts-expect-error The request of `deal` has no `hand`.
    deal.taking("hand", cardSchema);
    // @ts-expect-error One of the two is not a field of the request of `deal`.
    (field: "top" | "hand") => deal.taking(field, cardSchema);
  });
});
