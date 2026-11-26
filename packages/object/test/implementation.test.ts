import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AbsentBlob,
  encodeObject,
  encodeSchema,
  type Implementation,
  Implementations,
  type Link,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
  type Schema,
} from "../src/index.ts";
import { schemaTaking } from "./documents.ts";

interface Text {
  readonly link: Link<unknown>;
  readonly text: string;
}

type PlainData = { readonly text: string };
type QuoteData = { readonly quotes: LinkValue<unknown> };

const plain: Schema<PlainData> = encodeSchema({ title: "Plain", fields: { text: { type: "string" } } });
const quote: Schema<QuoteData> = encodeSchema({ title: "Quote", fields: { quotes: { type: "link" } } });
const other = schemaTaking("text");

const plainText: Implementation<Text, PlainData> = {
  schema: plain,
  read: ({ link, data }) => ({ link, text: data.text }),
};
const quotedText: Implementation<Text, QuoteData> = {
  schema: quote,
  async read({ link, data }, reader) {
    const quoted = await texts.read(data.quotes.link, reader);
    return { link, text: `"${quoted.text}"` };
  },
};
const texts = new Implementations([plainText, quotedText]);

const hello = encodeObject(plain, { text: "hello" });
const echo = encodeObject(quote, { quotes: new LinkValue(hello.link) });
const blobs = (...objects: { bytes: Uint8Array; link: Link<unknown> }[]) =>
  new Map(objects.map(({ bytes, link }) => [link, bytes]));

describe("implementations", () => {
  it("read each object with the implementation of the schema it names", async () => {
    const reader = blobs(hello, echo);
    await expect(texts.read(hello.link, reader)).resolves.toEqual({ link: hello.link, text: "hello" });
    await expect(texts.read(echo.link, reader)).resolves.toEqual({ link: echo.link, text: '"hello"' });
  });

  it("read as the shape their implementations give, with no type named for it", () => {
    expectTypeOf(texts.read).returns.toEqualTypeOf<Promise<Text>>();
  });

  it("give the implementation of a schema by its link", () => {
    expect(texts.implementationOf(plain.link)).toBe(plainText);
    expect(texts.implementationOf(quote.link)).toBe(quotedText);
  });

  it("give no implementation of a schema that is not one of theirs", () => {
    expect(texts.implementationOf(other.link)).toBeUndefined();
  });

  it("refuse an object written to a schema that is not one of theirs", async () => {
    const object = encodeObject(other, { text: "hello" });
    await expect(texts.read(object.link, blobs(object))).rejects.toThrow(`${other.link} is not a schema read here`);
  });

  it("refuse an object whose data does not fit its schema", async () => {
    const bytes = objectFormat.encode(new ObjectValue(plain.link, { body: "hello" }));
    await expect(texts.read(linkOf(bytes), new Map([[linkOf(bytes), bytes]]))).rejects.toThrow(
      "the data does not fit its schema",
    );
  });

  it("refuse an object that links to one the reader gives no blob for, by an error that has that link", async () => {
    const reading = texts.read(echo.link, blobs(echo));
    await expect(reading).rejects.toBeInstanceOf(AbsentBlob);
    await expect(reading).rejects.toMatchObject({ link: hello.link });
  });

  it("refuse a blob given for a link other than its own", async () => {
    await expect(texts.read(hello.link, new Map([[hello.link, echo.bytes]]))).rejects.toThrow(
      `the blob given for ${hello.link} is another blob`,
    );
  });

  it("refuse two implementations of one schema", () => {
    expect(() => new Implementations([plainText, { ...plainText }])).toThrow(
      `${plain.link} is given two implementations`,
    );
  });
});
