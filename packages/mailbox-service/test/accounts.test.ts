import { type Link, linkOf } from "@estoc/object";
import { describe, expect, it, onTestFinished } from "vitest";
import { type Accounts, MemoryAccounts } from "../src/server.ts";
import { SqliteAccounts } from "../src/sqlite.ts";
import { makeTemporaryPath } from "./fixtures.ts";

const linkNamed = (name: string) => linkOf(new TextEncoder().encode(name)) as Link<never>;

async function openInTemporaryFolder(): Promise<Accounts> {
  const accounts = new SqliteAccounts(await makeTemporaryPath());
  onTestFinished(() => accounts.close());
  return accounts;
}

describe.each([
  { name: "a MemoryAccounts", open: async (): Promise<Accounts> => new MemoryAccounts() },
  { name: "a SqliteAccounts", open: openInTemporaryFolder },
])("$name", ({ open }) => {
  it("keeps one account for a root, of two added at once", async () => {
    const accounts = await open();
    const [alice, bob] = [linkNamed("alice"), linkNamed("bob")];
    expect(await Promise.all([accounts.add(alice, linkNamed("one")), accounts.add(alice, linkNamed("two"))])).toEqual([
      true,
      false,
    ]);
    expect(await accounts.has(alice)).toBe(true);
    expect(await accounts.has(bob)).toBe(false);
    expect(await accounts.add(bob, linkNamed("three"))).toBe(true);
  });
});
