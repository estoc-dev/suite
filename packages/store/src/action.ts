import { type Bytes, type EncodedObject, encodeObject, type Link, type Schema, type ValueMap } from "@estoc/object";
import type { Batch, RecordBatch } from "./batch.ts";
import { type RowKeeper, type RowsByIndex, readRows } from "./scan.ts";
import type { RecordedStatements, StagedStore, Store } from "./store.ts";

export interface ActionOutcome<R extends ValueMap> {
  readonly result: EncodedObject<R>;
  /**
   * The roots written and the statements recorded, in the order their batches went through. Each
   * says that its batch went through, and not that the store held less before it.
   */
  readonly commits: readonly Link<unknown>[];
}

type Run<Q extends ValueMap, R extends ValueMap, E extends object> = (
  request: Q,
  store: Store,
  environment: E,
) => R | Promise<R>;

// `perform` reads what an action runs, which nothing outside this package can.
let runOf: <Q extends ValueMap, R extends ValueMap, E extends object>(action: Action<Q, R, E>) => Run<Q, R, E>;

/**
 * - The request schema names the action: what offers several actions tells them apart by it.
 * - `E` is what an action is given that a store cannot give, such as a clock.
 */
export class Action<Q extends ValueMap, R extends ValueMap, E extends object = object> {
  readonly requestSchema: Schema<Q>;
  readonly resultSchema: Schema<R>;
  readonly #run: Run<Q, R, E>;

  static {
    runOf = (action) => action.#run;
  }

  constructor(requestSchema: Schema<Q>, resultSchema: Schema<R>, run: Run<Q, R, E>) {
    this.requestSchema = requestSchema;
    this.resultSchema = resultSchema;
    this.#run = run;
  }
}

/**
 * `run` answers with the data of the result and does not say what it committed: that is read off
 * the store it is given.
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
  if (!(readRows in store)) throw new TypeError("an action is performed on a store made by `new Store`");
  const commits: Link<unknown>[] = [];
  const data = await runOf(action)(request, new NotingStore(store as Store & RowKeeper, commits), environment);
  return { result: encodeObject(action.resultSchema, data), commits };
}

/** Its rows are those of the store it is over, so an action scans it as it would that store. */
class NotingStore implements Store, RowKeeper {
  readonly #store: Store & RowKeeper;
  readonly #commits: Link<unknown>[];

  constructor(store: Store & RowKeeper, commits: Link<unknown>[]) {
    this.#store = store;
    this.#commits = commits;
  }

  [readRows]<T>(use: (rows: RowsByIndex) => Promise<T>): Promise<T> {
    return this.#store[readRows](use);
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return this.#store.get(link);
  }

  async write(batch: Batch): Promise<void> {
    await (await this.stage(batch)).commit();
  }

  async stage({ roots, blobs }: Batch): Promise<StagedStore> {
    // Read once, since an iterable may give its roots only the first time.
    const stagedRoots = [...roots];
    const stagedStore = await this.#store.stage({ roots: stagedRoots, blobs });
    // What a store stages keeps rows.
    return new NotingStagedStore(stagedStore as StagedStore & RowKeeper, () => this.#commits.push(...stagedRoots));
  }

  async record({ statements, blobs }: RecordBatch): Promise<void> {
    const statementLinks = [...statements];
    await this.#store.record({ statements: statementLinks, blobs });
    this.#commits.push(...statementLinks);
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
}

class NotingStagedStore implements StagedStore, RowKeeper {
  readonly #stagedStore: StagedStore & RowKeeper;
  readonly #note: () => void;

  constructor(stagedStore: StagedStore & RowKeeper, note: () => void) {
    this.#stagedStore = stagedStore;
    this.#note = note;
  }

  [readRows]<T>(use: (rows: RowsByIndex) => Promise<T>): Promise<T> {
    return this.#stagedStore[readRows](use);
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return this.#stagedStore.get(link);
  }

  async commit(): Promise<void> {
    await this.#stagedStore.commit();
    this.#note();
  }
}
