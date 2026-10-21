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

// A reply names the note it answers by link, and reads with that note.
const replySchema = await schemaOf({ to: { $ref: "https://estoc.dev/schema/link" }, text: { type: "string" } });

interface Reply {
  readonly to: Note;
  readonly text: string;
}

const replies = new View<Reply>([
  reading(replySchema, (data, _, blobs) => {
    const { to, text } = data as { to: Link<Note>; text: string };
    return { to: notes.follow(to, blobs), text };
  }),
]);

describe("a view whose reading follows a link", () => {
  const note = encodeObject(first, { text: "lunch?" });
  const other = encodeObject(first, { text: "dinner?" });
  const reply = encodeObject(replySchema, { to: note.link, text: "yes" });

  it("reads with the object that the link names, from the blobs given", () => {
    const blobs = new Map([[note.link, received(note.bytes)]]);
    expect(replies.decode(received(reply.bytes), blobs)).toEqual({ to: { text: "lunch?", link: note.link }, text: "yes" });
  });

  it("refuses an object whose link has no blob given", () => {
    expect(() => replies.decode(received(reply.bytes))).toThrow(/no blob is given/);
  });

  it("refuses an object whose link is given another blob", () => {
    const blobs = new Map([[note.link, received(other.bytes)]]);
    expect(() => replies.decode(received(reply.bytes), blobs)).toThrow(/is another blob/);
  });
});

describe("a reading of a schema", () => {
  it("refuses data that does not fit the schema before it is read", () => {
    const read = vi.fn(() => 1);
    expect(() => new View([reading(first, read)]).encode(first.link, { text: 1 })).toThrow(/does not fit/);
    expect(read).not.toHaveBeenCalled();
  });
});
