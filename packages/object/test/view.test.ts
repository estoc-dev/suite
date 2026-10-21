import { describe, expect, it, vi } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import { encodeJson, encodeObject, encodeSchema, linkSchema, View, type JsonObject, type Link } from "../src/index.ts";

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
  readonly language: string | undefined;
  readonly link: Link<Note>;
}

// Notes of both schemas read, and new notes are written to the later one.
const notes = new View<Note, { readonly text: string; readonly language: string }>(
  [
    { schema: first, read: (data, { link }) => ({ text: (data as { text: string }).text, language: undefined, link }) },
    {
      schema: second,
      read: (data, { link }) => {
        const { body, language } = data as { body: string; language: string };
        return { text: body, language, link };
      },
    },
  ],
  { schema: second.link, write: ({ text, language }) => ({ body: text, language }) },
);

// Bytes that come from elsewhere carry no label.
const received = (bytes: Uint8Array): Uint8Array => bytes;

describe("a view", () => {
  it("reads an object of each schema it has a reading of as the same type", () => {
    expect(notes.decode(received(encodeObject(first, { text: "hello" }).bytes)).text).toBe("hello");
    expect(notes.decode(received(encodeObject(second, { body: "hello", language: "en" }).bytes)).text).toBe("hello");
  });

  it("gives what it reads the link of the object", () => {
    const written = encodeObject(second, { body: "hello", language: "en" });
    expect(notes.decode(received(written.bytes)).link).toBe(written.link);
  });

  it("refuses an object written to a schema it has no reading of", () => {
    const written = encodeObject(unrelated, { title: "hello" });
    expect(() => notes.decode(received(written.bytes))).toThrow(/not read here/);
  });

  it("refuses an object whose data does not fit its schema, before its reading sees it", () => {
    const read = vi.fn(() => 1);
    expect(() => new View([{ schema: first, read }]).decode(encodeJson({ data: { text: 1 }, schema: first.link }))).toThrow(/does not fit/);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses two readings of one schema", () => {
    expect(() => new View([{ schema: first, read: () => 1 }, { schema: first, read: () => 2 }])).toThrow(/two readings/);
  });

  it("writes nothing without a writing", () => {
    const readOnly = new View([{ schema: first, read: () => 1 }]);
    // @ts-expect-error: refused at compile time too
    expect(() => readOnly.encode(1)).toThrow(/writes nothing/);
  });
});

describe("a view that writes", () => {
  it("writes a value to the schema of its writing, as an object that reads back as the same value", () => {
    const note = notes.encode({ text: "hello", language: "en" });
    expect(note.link).toBe(encodeObject(second, { body: "hello", language: "en" }).link);
    expect(note).toEqual({ text: "hello", language: "en", link: note.link });
  });

  it("refuses a value whose data does not fit that schema, before its reading sees it", () => {
    const read = vi.fn(() => 1);
    const misnamed = new View([{ schema: first, read }], { schema: first.link, write: (text: string) => ({ body: text }) });
    expect(() => misnamed.encode("hello")).toThrow(/does not fit/);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a writing to a schema it has no reading of", () => {
    expect(() => new View([{ schema: first, read: () => 1 }], { schema: second.link, write: () => null })).toThrow(/does not read/);
  });
});

// A reply names the note it answers by link, and reads with that note.
const replySchema = await schemaOf({ to: linkSchema, text: { type: "string" } });

interface Reply {
  readonly to: Note;
  readonly text: string;
}

const replies = new View<Reply>([
  {
    schema: replySchema,
    read: (data, _, blobs) => {
      const { to, text } = data as { to: Link<Note>; text: string };
      return { to: notes.follow(to, blobs), text };
    },
  },
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
