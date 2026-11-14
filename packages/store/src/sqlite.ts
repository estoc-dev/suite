import { DatabaseSync, type SQLTagStore } from "node:sqlite";
import type { Link } from "@estoc/object";
import type { RecordObject } from "./record.ts";
import type { Backend } from "./store.ts";

/** Keeps a store in one SQLite file, writing each batch that is put as one transaction. */
export class SqliteBackend implements Backend {
  readonly #database: DatabaseSync;
  readonly #sql: SQLTagStore;

  /**
   * Opens the file at `path`, making it when it is missing.
   *
   * @throws when the folder of `path` is missing, or the file is not a database.
   */
  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    // FULL, the default, leaves the journal's removal unsynced, so a write
    // followed closely by a power loss can be rolled back.
    this.#database.exec(`
      PRAGMA synchronous = EXTRA;
      CREATE TABLE IF NOT EXISTS blobs (link TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS records (link TEXT PRIMARY KEY);
    `);
    this.#sql = this.#database.createTagStore();
  }

  async get(link: Link<unknown>): Promise<Uint8Array | undefined> {
    return this.#sql.get`SELECT bytes FROM blobs WHERE link = ${link}`?.bytes as Uint8Array | undefined;
  }

  async has(link: Link<unknown>): Promise<boolean> {
    return this.#sql.get`SELECT 1 FROM blobs WHERE link = ${link}` !== undefined;
  }

  async put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>, records: Iterable<Link<RecordObject>>): Promise<void> {
    this.#database.exec("BEGIN");
    try {
      for (const [link, bytes] of blobs) this.#sql.run`INSERT OR IGNORE INTO blobs VALUES (${link}, ${bytes})`;
      for (const link of records) this.#sql.run`INSERT OR IGNORE INTO records VALUES (${link})`;
      this.#database.exec("COMMIT");
    } catch (error) {
      // SQLite rolls back by itself on some errors, such as a full disk.
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async *records(start = 0): AsyncIterable<Link<RecordObject>> {
    // Read whole, so that no statement holds a read lock on the file while the caller goes through the links.
    const rows = this.#sql.all`SELECT link FROM records ORDER BY rowid LIMIT -1 OFFSET ${start}`;
    for (const { link } of rows) yield link as Link<RecordObject>;
  }

  async *blobs(start = 0): AsyncIterable<Link<unknown>> {
    const rows = this.#sql.all`SELECT link FROM blobs ORDER BY rowid LIMIT -1 OFFSET ${start}`;
    for (const { link } of rows) yield link as Link<unknown>;
  }

  async positionOf(link: Link<unknown>): Promise<number | undefined> {
    // No blob is deleted, and one put again is ignored, so the rowids run from 1 without a gap.
    const rowid = this.#sql.get`SELECT rowid FROM blobs WHERE link = ${link}`?.rowid as number | undefined;
    return rowid === undefined ? undefined : rowid - 1;
  }

  /** Closes the file, after which every call rejects. */
  close(): void {
    this.#database.close();
  }
}
