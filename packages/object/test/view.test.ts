import { describe, expect, it, vi } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import { encodeObject, encodeSchema, reading, View, type JsonObject, type Link } from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const schemaOf = (properties: JsonObject) =>
  encodeSchema(
    { $schema: DRAFT, type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    defaultValidator,
  );

// A note was first written as its text alone, and later with its language.
const first = await schemaOf({ text: { type: "string" } });
const second = await schemaOf({ body: { type: "string" }, language: { type: "string" } });
const unrelated = await schemaOf({ title: { type: "string" } });

interface Note {
  readonly text: string;
  readonly link: Link<Note>;
}

const notes = new View<Note>([
  reading(first, (data, { link }) => ({ text: (data as { text: string }).text, link })),
  reading(second, (data, { link }) => ({ text: (data as { body: string }).body, link })),
]);

// Bytes that come from elsewhere carry no label.
const received = (bytes: Uint8Array): Uint8Array => bytes;

describe("a view", () => {
  it("reads an object of each schema it has a reading of as the same type", () => {
    expect(notes.encode(first.link, { text: "hello" }).text).toBe("hello");
    expect(notes.encode(second.link, { body: "hello", language: "en" }).text).toBe("hello");
  });

  it("gives what it reads the link of the object", () => {
    const written = encodeObject(second, { body: "hello", language: "en" });
    expect(notes.decode(received(written.bytes)).link).toBe(written.link);
  });

  it("refuses an object written to a schema it has no reading of", () => {
    const written = encodeObject(unrelated, { title: "hello" });
    expect(() => notes.decode(received(written.bytes))).toThrow(/not read here/);
    expect(() => notes.encode(unrelated.link, { title: "hello" })).toThrow(/not read here/);
  });

  it("refuses two readings of one schema", () => {
    expect(() => new View([reading(first, () => 1), reading(first, () => 2)])).toThrow(/two readings/);
  });
});

describe("a reading of a schema", () => {
  it("refuses data that does not fit the schema before it is read", () => {
    const read = vi.fn(() => 1);
    expect(() => new View([reading(first, read)]).encode(first.link, { text: 1 })).toThrow(/does not fit/);
    expect(read).not.toHaveBeenCalled();
  });
});
