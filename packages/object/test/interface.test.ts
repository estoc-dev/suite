import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import {
  DRAFT_2020_12,
  encodeObject,
  encodeSchema,
  type Implementation,
  Implementations,
  interfaceNamed,
  type Json,
  type JsonLink,
  json,
  jsonSchema,
  type Link,
  linkOf,
  linkSchema,
  NewerSchema,
  type Schema,
} from "../src/index.ts";

interface Text {
  readonly link: Link<unknown>;
  readonly text: string;
}

type PlainData = { readonly text: string };
type QuoteData = { readonly quotes: JsonLink<Text> };

const textAt = ({ link }: { readonly link: Link<unknown> }) => link as Link<Text>;

const plain: Schema<Json, PlainData> = await encodeSchema(
  {
    $schema: DRAFT_2020_12,
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  defaultValidator,
);
const quote: Schema<Json, QuoteData> = await encodeSchema(
  {
    $schema: DRAFT_2020_12,
    type: "object",
    properties: { quotes: linkSchema },
    required: ["quotes"],
    additionalProperties: false,
  },
  defaultValidator,
);
const other = await encodeSchema({ $schema: DRAFT_2020_12, type: "object" }, defaultValidator);

const plainText: Implementation<Json, Text, PlainData> = {
  schema: plain,
  read: ({ link, data }) => ({ link, text: data.text }),
};
const quotedText: Implementation<Json, Text, QuoteData> = {
  schema: quote,
  async read({ link, data }, reader) {
    const quoted = await texts.read(data.quotes.$link, reader);
    return { link, text: `"${quoted.text}"` };
  },
};
const texts = new Implementations(jsonSchema, [plainText, quotedText]);

const hello = encodeObject(plain, { text: "hello" });
const echo = encodeObject(quote, { quotes: { $link: textAt(hello) } });
const blobs = (...objects: { bytes: Uint8Array; link: Link<unknown> }[]) =>
  new Map(objects.map(({ bytes, link }) => [link, bytes]));

describe("an interface named by text", () => {
  it("is the UTF-8 bytes of its name, under their SHA-256", () => {
    const named = interfaceNamed("Key");
    expect(named.bytes).toEqual(new TextEncoder().encode("Key"));
    expect(named.link).toBe(`sha256:${createHash("sha256").update("Key").digest("hex")}`);
  });
});

describe("implementations", () => {
  it("read each object with the implementation of the schema it names", async () => {
    const reader = blobs(hello, echo);
    await expect(texts.read(textAt(hello), reader)).resolves.toEqual({ link: hello.link, text: "hello" });
    await expect(texts.read(textAt(echo), reader)).resolves.toEqual({ link: echo.link, text: '"hello"' });
  });

  it("read as the shape their implementations give, with no type named for it", () => {
    expectTypeOf(texts.read).returns.toEqualTypeOf<Promise<Text>>();
  });

  it("give the implementation of a schema by its link", () => {
    expect(texts.implementationOf(plain.link)).toBe(plainText);
    expect(texts.implementationOf(quote.link)).toBe(quotedText);
    expect(() => texts.implementationOf(other.link)).toThrow(`${other.link} is not a schema read here`);
  });

  it("refuse an object written to a schema that is not one of theirs", async () => {
    const object = encodeObject(other, { text: "hello" });
    await expect(texts.read(textAt(object), blobs(object))).rejects.toThrow(`${other.link} is not a schema read here`);
  });

  it("refuse an object whose data does not fit its schema", async () => {
    const bytes = json.encode(json.object({ text: 1 }, plain.link));
    await expect(texts.read(linkOf(bytes), new Map([[linkOf(bytes), bytes]]))).rejects.toThrow(
      "the data does not fit its schema",
    );
  });

  it("refuse a link for which the reader gives no blob", async () => {
    await expect(texts.read(textAt(echo), blobs(echo))).rejects.toThrow(`no blob is given for ${hello.link}`);
  });

  it("refuse a blob given for a link other than its own", async () => {
    await expect(texts.read(textAt(hello), new Map([[hello.link, echo.bytes]]))).rejects.toThrow(
      `the blob given for ${hello.link} is another blob`,
    );
  });

  it("refuse two implementations of one schema", () => {
    expect(() => new Implementations(jsonSchema, [plainText, { ...plainText }])).toThrow(
      `${plain.link} is given two implementations`,
    );
  });
});

const following = (title: string, predecessor: Schema<Json>): Promise<Schema<Json, PlainData>> =>
  encodeSchema(
    {
      $schema: DRAFT_2020_12,
      title,
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      "x-follows": { $link: predecessor.link },
    },
    defaultValidator,
  );
const second = await following("second", plain);
const third = await following("third", second);

const textIn = (schema: Schema<Json, PlainData>): Implementation<Json, Text, PlainData> => ({
  schema,
  read: ({ link, data }) => ({ link, text: data.text }),
});

describe("implementations of schemas that follow others", () => {
  it("refuse to leave out a schema that one of theirs follows", () => {
    expect(() => new Implementations(jsonSchema, [textIn(third), textIn(plain)])).toThrow(
      `${third.link} follows ${second.link}, which is not read here`,
    );
  });

  it("take a schema along with each schema before it", async () => {
    const all = new Implementations(jsonSchema, [plainText, textIn(second), textIn(third)]);
    const object = encodeObject(third, { text: "hello" });
    await expect(all.read(textAt(object), blobs(object))).resolves.toEqual({ link: object.link, text: "hello" });
  });

  it("refuse an object of a schema following one of theirs as a newer schema", async () => {
    const object = encodeObject(second, { text: "hello" });
    const error = await texts.read(textAt(object), blobs(object, second)).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(NewerSchema);
    expect(error).toMatchObject({ name: "NewerSchema", schema: second.link, predecessor: plain.link });
  });

  it("find one of theirs through a schema that is not", async () => {
    const object = encodeObject(third, { text: "hello" });
    const error = await texts.read(textAt(object), blobs(object, third, second)).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(NewerSchema);
    expect(error).toMatchObject({ schema: third.link, predecessor: plain.link });
  });

  it("refuse an object as not read here when the reader does not give a schema between", async () => {
    const object = encodeObject(third, { text: "hello" });
    await expect(texts.read(textAt(object), blobs(object, third))).rejects.toThrow(
      `${third.link} is not a schema read here`,
    );
  });

  it("refuse an object as not read here when the reader leads back to a schema already passed", async () => {
    const object = encodeObject(third, { text: "hello" });
    const reader = blobs(object, third, { link: second.link, bytes: third.bytes });
    await expect(texts.read(textAt(object), reader)).rejects.toThrow(`${third.link} is not a schema read here`);
  });
});
