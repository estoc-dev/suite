import { DatabaseSync, type SQLTagStore } from "node:sqlite";
import type { Link } from "@estoc/object";
import type { Backend } from "./backend.ts";

/**
 * - The file is not encrypted and holds Secrets among its blobs, so it goes where only its user can
 *   read it.
 * - Stores are joined by writing bundles from one to another, not by copying their files. A file
 *   copied while it is open, as by a tool that syncs a folder, can come out damaged.
 */
export class SqliteBackend implements Backend {
  readonly #database: DatabaseSync;
  readonly #sql: SQLTagStore;

  constructor(path: string, { isReadOnly = false }: { readonly isReadOnly?: boolean } = {}) {
    this.#database = new DatabaseSync(path, { readOnly: isReadOnly });
    if (isReadOnly) {
      // SQLite reads a file at the first statement, so one that holds no blobs of a store is refused here.
      this.#database.exec("SELECT link, bytes FROM blobs LIMIT 0");
    } else {
      // FULL, the default, leaves the journal's removal unsynced, so a write
      // followed closely by a power loss can be rolled back.
      this.#database.exec(`
        PRAGMA synchronous = EXTRA;
        CREATE TABLE IF NOT EXISTS blobs (link TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      `);
    }
    this.#sql = this.#database.createTagStore();
  }

  async get(link: Link<unknown>): Promise<Uint8Array | undefined> {
    return this.#sql.get`SELECT bytes FROM blobs WHERE link = ${link}`?.bytes as Uint8Array | undefined;
  }

  async has(link: Link<unknown>): Promise<boolean> {
    return this.#sql.get`SELECT 1 FROM blobs WHERE link = ${link}` !== undefined;
  }

  async put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>): Promise<void> {
    this.#database.exec("BEGIN");
    try {
      for (const [link, bytes] of blobs) this.#sql.run`INSERT OR IGNORE INTO blobs VALUES (${link}, ${bytes})`;
      this.#database.exec("COMMIT");
    } catch (error) {
      // SQLite rolls back by itself on some errors, such as a full disk.
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async *blobs(start = 0): AsyncIterable<Link<unknown>> {
    // Read whole, so that no statement holds a read lock on the file while the caller goes through the links.
    const rows = this.#sql.all`SELECT link FROM blobs ORDER BY rowid LIMIT -1 OFFSET ${start}`;
    for (const { link } of rows) yield link as Link<unknown>;
  }

  close(): void {
    this.#database.close();
  }
}
