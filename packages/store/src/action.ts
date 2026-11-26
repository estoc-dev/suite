import {
  type Bytes,
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  readObject,
  type Schema,
  type Value,
  type ValueMap,
} from "@estoc/object";
import type { Batch, RecordBatch } from "./batch.ts";
import type { Rows } from "./sorted-rows.ts";
import type { FieldNames, OrderedIndex } from "./source.ts";
import type { RecordedStatements, Scannable, StagedStore, Store } from "./store.ts";

export interface ActionOutcome<R extends ValueMap> {
  readonly result: EncodedObject<R>;
  /**
   * The roots written and the statements recorded by the batches that went through.
   * - The links of a batch are in the order it gave them, and a batch begun after another went
   *   through comes after it. Batches under way at once come in either order.
   * - Each says that its batch went through, and not that the store held less before it.
   */
  readonly commits: readonly Link<unknown>[];
}

type Run<Q extends ValueMap, R extends ValueMap, E extends object> = (
  request: Q,
  store: Store,
  environment: E,
) => R | Promise<R>;

/**
 * For a field of a request whose links are to objects of one schema, that schema. The schema of a
 * request does not say it: there a link is to anything.
 */
type TargetSchemas<Q extends ValueMap> = {
  readonly [K in keyof Q]?: Exclude<Q[K], undefined> extends
    | LinkValue<EncodedObject<infer F>>
    | readonly LinkValue<EncodedObject<infer F>>[]
    ? Schema<F>
    : never;
};

// `perform` reads what an action runs, which nothing outside this package can.
let runOf: <Q extends ValueMap, R extends ValueMap, E extends object>(action: Action<Q, R, E>) => Run<Q, R, E>;

/**
 * - The request schema names the action: what offers several actions tells them apart by it.
 * - `E` is what an action is given that a store cannot give, such as a clock.
 */
export class Action<Q extends ValueMap, R extends ValueMap, E extends object = object> {
  readonly requestSchema: Schema<Q>;
  readonly resultSchema: Schema<R>;
  readonly targetSchemas: TargetSchemas<Q>;
  readonly #run: Run<Q, R, E>;

  static {
    runOf = (action) => action.#run;
  }

  constructor(
    requestSchema: Schema<Q>,
    resultSchema: Schema<R>,
    run: Run<Q, R, E>,
    targetSchemas: TargetSchemas<Q> = {},
  ) {
    this.requestSchema = requestSchema;
    this.resultSchema = resultSchema;
    this.#run = run;
    this.targetSchemas = targetSchemas;
  }

  taking<K extends keyof Q>(field: K, schema: NonNullable<TargetSchemas<Q>[K]>): Action<Q, R, E> {
    return new Action(this.requestSchema, this.resultSchema, this.#run, { ...this.targetSchemas, [field]: schema });
  }
}

/**
 * - `run` answers with the data of the result and does not say what it committed: that is read off
 *   the store it is given.
 * - A batch `run` leaves under way when it answers is waited for, and does not fail the action when
 *   it is refused: the action fails as `run` throws.
 * - Once `perform` has taken what `run` answered or threw, the store given to `run` refuses `write`,
 *   `record` and the `commit` of what it staged.
 */
export function actionOver<Q extends ValueMap, R extends ValueMap, E extends object = object>(
  requestSchema: Schema<Q>,
  resultSchema: Schema<R>,
  run: (request: Q, store: Store, environment: E) => NoInfer<R> | Promise<NoInfer<R>>,
): Action<Q, R, E> {
  return new Action(requestSchema, resultSchema, run);
}

/**
 * - Neither the request nor the result is written to the store: what stays of an action is what it
 *   committed.
 * - When the action throws, what it committed before stays in the store, and its commits are not
 *   given.
 */
export function perform<Q extends ValueMap, R extends ValueMap>(
  store: Store,
  action: Action<Q, R>,
  request: Q,
): Promise<ActionOutcome<R>>;
export function perform<Q extends ValueMap, R extends ValueMap, E extends object>(
  store: Store,
  action: Action<Q, R, E>,
  request: Q,
  environment: E,
): Promise<ActionOutcome<R>>;
export async function perform<Q extends ValueMap, R extends ValueMap>(
  store: Store,
  action: Action<Q, R>,
  request: Q,
  environment: object = {},
): Promise<ActionOutcome<R>> {
  // The type of a request admits what its schema refuses, such as a field the schema does not name.
  const validRequest = action.requestSchema.validate(request);
  const targetSchemas: { readonly [field: string]: Schema | undefined } = action.targetSchemas;
  for (const [field, schema] of Object.entries(targetSchemas)) {
    if (schema === undefined) continue;
    for (const link of linksAt(validRequest[field])) await readObject(store, link, schema);
  }
  const commitNotes = new CommitNotes();
  let data: R;
  try {
    data = await runOf(action)(validRequest, new NotingStore(store, commitNotes), environment);
  } finally {
    commitNotes.close();
  }
  return { result: encodeObject(action.resultSchema, data), commits: await commitNotes.settledLinks() };
}

function linksAt(value: Value | undefined): Link<unknown>[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((each) => each instanceof LinkValue).map(({ link }) => link);
}

class CommitNotes {
  readonly #links: Link<unknown>[] = [];
  readonly #notedBatches: Promise<void>[] = [];
  #isClosed = false;

  note(links: readonly Link<unknown>[], putThrough: () => Promise<void>): Promise<void> {
    if (this.#isClosed) throw new Error("the store given to an action takes no batch after the action answered");
    const notedBatch = putThrough().then(() => {
      // One at a time, since a batch may give more links than a call takes arguments.
      for (const link of links) this.#links.push(link);
    });
    this.#notedBatches.push(notedBatch);
    return notedBatch;
  }

  close(): void {
    this.#isClosed = true;
  }

  /**
   * The links of the batches that went through, once each batch begun has ended. After `close`, no
   * link is noted after these.
   */
  async settledLinks(): Promise<readonly Link<unknown>[]> {
    await Promise.allSettled(this.#notedBatches);
    return this.#links;
  }
}

class NotingStore implements Store {
  readonly #store: Store;
  readonly #commitNotes: CommitNotes;

  constructor(store: Store, commitNotes: CommitNotes) {
    this.#store = store;
    this.#commitNotes = commitNotes;
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return this.#store.get(link);
  }

  async write({ roots, blobs }: Batch): Promise<void> {
    // Read once, since an iterable may give its roots only the first time.
    const writtenRoots = [...roots];
    await this.#commitNotes.note(writtenRoots, () => this.#store.write({ roots: writtenRoots, blobs }));
  }

  async stage({ roots, blobs }: Batch): Promise<StagedStore> {
    const stagedRoots = [...roots];
    const stagedStore = await this.#store.stage({ roots: stagedRoots, blobs });
    return new NotingStagedStore(stagedStore, stagedRoots, this.#commitNotes);
  }

  async record({ statements, blobs }: RecordBatch): Promise<void> {
    const statementLinks = [...statements];
    await this.#commitNotes.note(statementLinks, () => this.#store.record({ statements: statementLinks, blobs }));
  }

  blobs(): AsyncIterable<Link<unknown>> {
    return this.#store.blobs();
  }

  records(): AsyncIterable<Link<EncodedObject>> {
    return this.#store.records();
  }

  recordedStatements(): Promise<RecordedStatements> {
    return this.#store.recordedStatements();
  }

  closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>> {
    return this.#store.closure(link);
  }

  heldCollection(link: Link<unknown>): Promise<Scannable> {
    return this.#store.heldCollection(link);
  }

  scan<F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>): Promise<Rows<F, By>> {
    return this.#store.scan(index);
  }
}

class NotingStagedStore implements StagedStore {
  readonly #stagedStore: StagedStore;
  readonly #roots: readonly Link<unknown>[];
  readonly #commitNotes: CommitNotes;

  constructor(stagedStore: StagedStore, roots: readonly Link<unknown>[], commitNotes: CommitNotes) {
    this.#stagedStore = stagedStore;
    this.#roots = roots;
    this.#commitNotes = commitNotes;
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return this.#stagedStore.get(link);
  }

  async commit(): Promise<void> {
    await this.#commitNotes.note(this.#roots, () => this.#stagedStore.commit());
  }

  scan<F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>): Promise<Rows<F, By>> {
    return this.#stagedStore.scan(index);
  }
}
