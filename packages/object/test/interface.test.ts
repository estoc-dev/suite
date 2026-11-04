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
  type LineageData,
  type Link,
  lineageOf,
  lineageSchema,
  linkOf,
  linkSchema,
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
const texts = new Implementations(json, [plainText, quotedText]);

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
    expect(() => new Implementations(json, [plainText, { ...plainText }])).toThrow(
      `${plain.link} is given two implementations`,
    );
  });
});

const lineages: Schema<Json, LineageData<Schema<Json>>> = await encodeSchema(lineageSchema, defaultValidator);
const lineageOfSchemas = (...versions: Schema<Json>[]) =>
  lineageOf(encodeObject(lineages, { versions: versions.map(({ link }) => ({ $link: link })) }));

const textSchemaTitled = (title: string): Promise<Schema<Json, PlainData>> =>
  encodeSchema(
    {
      $schema: DRAFT_2020_12,
      title,
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    defaultValidator,
  );
const second = await textSchemaTitled("second");
const third = await textSchemaTitled("third");

const textIn = (schema: Schema<Json, PlainData>): Implementation<Json, Text, PlainData> => ({
  schema,
  read: ({ link, data }) => ({ link, text: data.text }),
});

describe("implementations of versions", () => {
  const lineage = lineageOfSchemas(plain, second, third);

  it("read a version alone when they pin no lineage of it", async () => {
    const alone = new Implementations(json, [textIn(third)]);
    const object = encodeObject(third, { text: "hello" });
    await expect(alone.read(textAt(object), blobs(object))).resolves.toEqual({ link: object.link, text: "hello" });
  });

  it("refuse to leave out a version on a lineage they pin", () => {
    expect(() => new Implementations(json, [textIn(third), plainText], [lineage])).toThrow(
      `${lineage.link} lists ${second.link}, which is not read here`,
    );
  });

  it("read each version on a lineage they pin", async () => {
    const all = new Implementations(json, [plainText, textIn(second), textIn(third)], [lineage]);
    const object = encodeObject(second, { text: "hello" });
    await expect(all.read(textAt(object), blobs(object))).resolves.toEqual({ link: object.link, text: "hello" });
  });

  it("refuse an object of a version after their lineage as of any schema not read here", async () => {
    const upToSecond = new Implementations(json, [plainText, textIn(second)], [lineageOfSchemas(plain, second)]);
    const object = encodeObject(third, { text: "hello" });
    await expect(upToSecond.read(textAt(object), blobs(object))).rejects.toThrow(
      `${third.link} is not a schema read here`,
    );
  });
});
