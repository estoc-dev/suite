import { encodeSchema, type JsonObject } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { mailboxSchema } from "../src/index.ts";

const memory = await encodeSchema(mailboxSchema("Memory mailbox", { name: { type: "string" } }, ["name"]), defaultValidator);
const key = "a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209";

describe("a mailbox schema", () => {
  it("takes a key and the transport's fields", () => {
    expect(() => memory.validate({ key, name: "q" })).not.toThrow();
  });

  it.each<[string, JsonObject]>([
    ["without a key", { name: "q" }],
    ["without a field its transport requires", { key }],
    ["whose key is in uppercase hex", { key: key.toUpperCase(), name: "q" }],
    ["whose key is 31 bytes", { key: key.slice(2), name: "q" }],
    ["with a field its transport does not add", { key, name: "q", owner: "alice" }],
  ])("refuses a mailbox %s", (_, data) => {
    expect(() => memory.validate(data)).toThrow();
  });

  it("is not made with a transport field named key", () => {
    expect(() => mailboxSchema("Mailbox", { key: { type: "string" } })).toThrow(/a field of every mailbox/);
  });
});
