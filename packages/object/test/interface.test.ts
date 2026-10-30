import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
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
  type Link,
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
const texts = new Implementations<Json, Text>(json, [plainText, quotedText]);

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

  it("give the implementation of a schema by its link", () => {
    expect(texts.of(plain.link)).toBe(plainText);
    expect(texts.of(quote.link)).toBe(quotedText);
    expect(() => texts.of(other.link)).toThrow(`${other.link} is not a schema read here`);
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
    expect(() => new Implementations<Json, Text>(json, [plainText, { ...plainText }])).toThrow(
      `${plain.link} is given two implementations`,
    );
  });
});
