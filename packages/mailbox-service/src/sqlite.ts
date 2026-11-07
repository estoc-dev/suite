import { DatabaseSync, type SQLTagStore } from "node:sqlite";
import type { KeyObject, Signature } from "@estoc/identity";
import { type Link, linkOf } from "@estoc/object";
import type { Mailboxes, OpenMailbox } from "./mailboxes.ts";
import type { Accounts } from "./server.ts";

/** Keeps accounts in a SQLite file. */
export class SqliteAccounts implements Accounts {
  readonly #database: DatabaseSync;
  readonly #sql: SQLTagStore;

  /**
   * Opens the file at `path`, making it when it is missing.
   *
   * @throws when the folder of `path` is missing, or the file is not a database.
   */
  constructor(path: string) {
    this.#database = openDatabase(
      path,
      "CREATE TABLE IF NOT EXISTS accounts (root TEXT PRIMARY KEY, acknowledgement TEXT NOT NULL);",
    );
    this.#sql = this.#database.createTagStore();
  }

  async add(root: Link<KeyObject>, acknowledgement: Link<Signature>): Promise<boolean> {
    return this.#sql.run`INSERT OR IGNORE INTO accounts VALUES (${root}, ${acknowledgement})`.changes === 1;
  }

  async has(root: Link<KeyObject>): Promise<boolean> {
    return this.#sql.get`SELECT 1 FROM accounts WHERE root = ${root}` !== undefined;
  }

  /** Closes the file, after which every call rejects. */
  close(): void {
    this.#database.close();
  }
}

/** Keeps mailboxes, and the ciphertexts that wait at each, in a SQLite file. */
export class SqliteMailboxes implements Mailboxes {
  readonly #database: DatabaseSync;
  readonly #sql: SQLTagStore;

  /**
   * Opens the file at `path`, making it when it is missing.
   *
   * @throws when the folder of `path` is missing, or the file is not a database.
   */
  constructor(path: string) {
    this.#database = openDatabase(
      path,
      `
      CREATE TABLE IF NOT EXISTS mailboxes (
        request TEXT PRIMARY KEY,
        acknowledgement TEXT NOT NULL,
        root TEXT NOT NULL,
        send_id TEXT NOT NULL UNIQUE,
        pickup_id TEXT NOT NULL UNIQUE,
        retention INTEGER NOT NULL,
        quota INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        send_id TEXT NOT NULL,
        link TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (send_id, link)
      );
      `,
    );
    this.#sql = this.#database.createTagStore();
  }

  async open(mailbox: OpenMailbox): Promise<OpenMailbox> {
    const { request, acknowledgement, root, sendId, pickupId, terms } = mailbox;
    const { changes } = this.#sql.run`
      INSERT OR IGNORE INTO mailboxes
      VALUES (${request}, ${acknowledgement}, ${root}, ${sendId}, ${pickupId},
        ${terms.retention}, ${terms.quota}, ${terms.size})
    `;
    if (changes === 1) return mailbox;
    return mailboxOf(this.#sql.get`SELECT * FROM mailboxes WHERE request = ${request}` as MailboxRow);
  }

  async mailboxOpenedBy(request: Link<Signature>): Promise<OpenMailbox | undefined> {
    const row = this.#sql.get`SELECT * FROM mailboxes WHERE request = ${request}` as MailboxRow | undefined;
    return row && mailboxOf(row);
  }

  async mailboxNamed(id: string): Promise<OpenMailbox | undefined> {
    const row = this.#sql.get`
      SELECT * FROM mailboxes WHERE send_id = ${id} OR pickup_id = ${id}
    ` as MailboxRow | undefined;
    return row && mailboxOf(row);
  }

  async put(
    sendId: string,
    ciphertext: Uint8Array,
    { at, since, quota }: { readonly at: number; readonly since: number; readonly quota: number },
  ): Promise<boolean> {
    const link = linkOf(ciphertext);
    return this.#transaction(() => {
      this.#removeExpired(sendId, since);
      if (this.#sql.get`SELECT 1 FROM messages WHERE send_id = ${sendId} AND link = ${link}` !== undefined) return true;
      const { bytes } = this.#sql.get`
        SELECT total(length(ciphertext)) AS bytes FROM messages WHERE send_id = ${sendId}
      ` as { bytes: number };
      if (bytes + ciphertext.length > quota) return false;
      this.#sql.run`INSERT INTO messages VALUES (${sendId}, ${link}, ${ciphertext}, ${at})`;
      return true;
    });
  }

  async drop(sendId: string, receipts: readonly Link<Uint8Array>[]): Promise<void> {
    this.#transaction(() => {
      for (const link of receipts) this.#sql.run`DELETE FROM messages WHERE send_id = ${sendId} AND link = ${link}`;
    });
  }

  async *queue(sendId: string, since: number): AsyncIterable<Uint8Array> {
    this.#removeExpired(sendId, since);
    // Read whole, so that no statement holds a read lock on the file while the caller goes through the ciphertexts.
    const rows = this.#sql.all`SELECT ciphertext FROM messages WHERE send_id = ${sendId} ORDER BY rowid`;
    for (const { ciphertext } of rows) yield ciphertext as Uint8Array;
  }

  /** Closes the file, after which every call rejects. */
  close(): void {
    this.#database.close();
  }

  #removeExpired(sendId: string, since: number): void {
    this.#sql.run`DELETE FROM messages WHERE send_id = ${sendId} AND at < ${since}`;
  }

  #transaction<T>(write: () => T): T {
    this.#database.exec("BEGIN");
    try {
      const value = write();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      // SQLite rolls back by itself on some errors, such as a full disk.
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

type MailboxRow = {
  readonly request: Link<Signature>;
  readonly acknowledgement: Link<Signature>;
  readonly root: Link<KeyObject>;
  readonly send_id: string;
  readonly pickup_id: string;
  readonly retention: number;
  readonly quota: number;
  readonly size: number;
};

const mailboxOf = ({
  request,
  acknowledgement,
  root,
  send_id,
  pickup_id,
  retention,
  quota,
  size,
}: MailboxRow): OpenMailbox => ({
  request,
  acknowledgement,
  root,
  sendId: send_id,
  pickupId: pickup_id,
  terms: { retention, quota, size },
});

function openDatabase(path: string, schema: string): DatabaseSync {
  const database = new DatabaseSync(path);
  // FULL, the default, leaves the journal's removal unsynced, so a write
  // followed closely by a power loss can be rolled back.
  database.exec(`PRAGMA synchronous = EXTRA; ${schema}`);
  return database;
}
