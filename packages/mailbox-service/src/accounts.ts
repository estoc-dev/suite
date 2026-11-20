import type { Link } from "@estoc/object";

export interface Accounts {
  /**
   * Keeps `acknowledgement` as the account of `identifier` unless it has one,
   * in one step. Resolves to whether it was kept.
   */
  add(identifier: Link<unknown>, acknowledgement: Link<unknown>): Promise<boolean>;
  has(identifier: Link<unknown>): Promise<boolean>;
}

export class MemoryAccounts implements Accounts {
  readonly #accounts = new Map<Link<unknown>, Link<unknown>>();

  async add(identifier: Link<unknown>, acknowledgement: Link<unknown>): Promise<boolean> {
    if (this.#accounts.has(identifier)) return false;
    this.#accounts.set(identifier, acknowledgement);
    return true;
  }

  async has(identifier: Link<unknown>): Promise<boolean> {
    return this.#accounts.has(identifier);
  }
}
