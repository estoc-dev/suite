import type { EstMap } from "@estoc/object";
import { string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { mailboxSchema } from "../src/index.ts";

const memory = mailboxSchema("Memory mailbox", { name: string() });
const key = new Uint8Array(32).fill(7);

describe("a mailbox schema", () => {
  it("takes a key and the transport's fields", () => {
    expect(() => memory.validate({ key, name: "q" })).not.toThrow();
  });

  it.each<[string, EstMap]>([
    ["without a key", { name: "q" }],
    ["without a field of its transport", { key }],
    ["whose key is in hex", { key: "07".repeat(32), name: "q" }],
    ["with a field its transport does not add", { key, name: "q", owner: "alice" }],
  ])("refuses a mailbox %s", (_, data) => {
    expect(() => memory.validate(data)).toThrow();
  });

  it("is not made with a transport field named key", () => {
    expect(() => mailboxSchema("Mailbox", { key: string() })).toThrow(/a field of every mailbox/);
  });
});
