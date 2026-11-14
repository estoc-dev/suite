import {
  encodeObject,
  itself,
  type Link,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
  type Reader,
  type ValueMap,
} from "@estoc/object";
import { any, array, link, optional, rootSchema, schema, schemaLanguage, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { inspect } from "../src/index.ts";

const noteSchema = schema("Note", { text: string(), replies: array(link()), more: optional(any()) });
const noteDocument = {
  title: "Note",
  fields: {
    text: { type: "string" },
    replies: { type: "array", items: { type: "link" } },
    more: { type: "any", optional: true },
  },
};
const photo = new TextEncoder().encode("a photo");
const reply = encodeObject(noteSchema, { text: "a reply", replies: [] });
const note = encodeObject(noteSchema, {
  text: "a note",
  replies: [new LinkValue(reply.link)],
  more: { files: [{ photo: new LinkValue(linkOf(photo)) }] },
});

function readerOf(...blobs: readonly Uint8Array[]): Reader {
  return new Map<Link<unknown>, Uint8Array>(blobs.map((bytes) => [linkOf(bytes), bytes]));
}

function objectOf(schemaLink: Link<unknown> | typeof itself, data: ValueMap): Uint8Array {
  return objectFormat.encode(new ObjectValue(schemaLink, data));
}

async function inspectedObject(bytes: Uint8Array, ...others: readonly Uint8Array[]) {
  const inspection = await inspect(linkOf(bytes), readerOf(bytes, ...others));
  if (inspection.kind !== "object") throw new Error(`read as ${inspection.kind}`);
  return inspection;
}

describe("a link the reader gives no blob for", () => {
  it("is absent", async () => {
    expect(await inspect(note.link, readerOf())).toEqual({ kind: "absent", link: note.link });
  });
});

describe("a blob that is not an object", () => {
  it("is bytes", async () => {
    expect(await inspect(linkOf(photo), readerOf(photo))).toEqual({ kind: "bytes", link: linkOf(photo), bytes: photo });
  });
});

describe("an object", () => {
  it("gives its data, and the links in it with their places, in the order its bytes hold them", async () => {
    const { link, bytes, data, links } = await inspectedObject(note.bytes, ...noteSchema.blobs);
    expect({ link, bytes, data }).toEqual({ link: note.link, bytes: note.bytes, data: note.data });
    expect(links).toEqual([
      { path: "#/more/files/0/photo", link: linkOf(photo) },
      { path: "#/replies/0", link: reply.link },
    ]);
  });

  it("gives the document of the schema it names, with no problems when its data fits", async () => {
    const { schema } = await inspectedObject(note.bytes, ...noteSchema.blobs);
    expect(schema).toEqual({ kind: "schema", link: noteSchema.link, document: noteDocument, problems: [] });
  });

  it("lists what in its data does not fit, each with its place", async () => {
    const misfit = objectOf(noteSchema.link, { text: 1, replies: [new LinkValue(reply.link), "a reply"], by: "me" });
    const { links, schema } = await inspectedObject(misfit, ...noteSchema.blobs);
    expect(schema).toMatchObject({
      kind: "schema",
      problems: ["#/by: not a field of the schema", "#/text: not a string", "#/replies/1: not a link"],
    });
    expect(links).toEqual([{ path: "#/replies/0", link: reply.link }]);
  });

  it("gives its data and links when the reader does not give its schema", async () => {
    const { data, links, schema } = await inspectedObject(note.bytes);
    expect(data).toEqual(note.data);
    expect(links).toHaveLength(2);
    expect(schema).toEqual({ kind: "absent", link: noteSchema.link });
  });

  it("leads to what it links to through the same reader", async () => {
    const reader = readerOf(note.bytes, reply.bytes, photo, ...noteSchema.blobs);
    const inspection = await inspect(note.link, reader);
    const links = inspection.kind === "object" ? inspection.links : [];
    const kinds = await Promise.all(links.map(async ({ link }) => (await inspect(link, reader)).kind));
    expect(kinds).toEqual(["bytes", "object"]);
  });
});

describe("the schema an object names", () => {
  async function refusalOf(bytes: Uint8Array, ...others: readonly Uint8Array[]) {
    const { data, schema } = await inspectedObject(bytes, ...others);
    expect(data).toEqual({ text: "a note" });
    if (schema.kind !== "refused") throw new Error(`read as ${schema.kind}`);
    return { link: schema.link, message: String(schema.error) };
  }

  it("is refused when it is bytes", async () => {
    const { link } = await refusalOf(objectOf(linkOf(photo), { text: "a note" }), photo);
    expect(link).toBe(linkOf(photo));
  });

  it("is refused when it is an object written to another schema than the root schema", async () => {
    const named = objectOf(reply.link, { text: "a note" });
    const { link, message } = await refusalOf(named, reply.bytes);
    expect(link).toBe(reply.link);
    expect(message).toContain(`the object is written to ${noteSchema.link}, not to ${rootSchema.link}`);
  });

  it("is refused when the object names itself and is not the root schema", async () => {
    const own = objectOf(itself, { text: "a note" });
    const { link, message } = await refusalOf(own);
    expect(link).toBe(linkOf(own));
    expect(message).toContain(`the object is written to ${linkOf(own)}, not to ${rootSchema.link}`);
  });

  it("is refused when its data fits the root schema and is not a document of the language", async () => {
    const float = objectOf(rootSchema.link, { title: "Float", fields: { value: { type: "float" } } });
    const { link, message } = await refusalOf(objectOf(linkOf(float), { text: "a note" }), float);
    expect(link).toBe(linkOf(float));
    expect(message).toContain("the type of the field value is one of");
  });
});

describe("a schema", () => {
  it("is an object written to the root schema, with no links in its data", async () => {
    const { data, links, schema } = await inspectedObject(noteSchema.bytes, rootSchema.bytes);
    expect(data).toEqual(noteDocument);
    expect(links).toEqual([]);
    expect(schema).toEqual({ kind: "schema", link: rootSchema.link, document: schemaLanguage.root, problems: [] });
  });
});

describe("the root schema", () => {
  it("names itself, and is read with its own bytes", async () => {
    const { link, data, schema } = await inspectedObject(rootSchema.bytes);
    expect(link).toBe(rootSchema.link);
    expect(data).toEqual(schemaLanguage.root);
    expect(schema).toEqual({ kind: "schema", link: rootSchema.link, document: schemaLanguage.root, problems: [] });
  });
});
