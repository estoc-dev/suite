import { describe, expect, expectTypeOf, it } from "vitest";
import {
  encodeObject,
  encodeSchema,
  type Implementation,
  Implementations,
  type Link,
  LinkValue,
  linkOf,
  objectFormat,
  type Schema,
  type Value,
} from "../src/index.ts";
import { fieldNames } from "./field-names.ts";

interface Text {
  readonly link: Link<unknown>;
  readonly text: string;
}

type PlainData = { readonly text: string };
type QuoteData = { readonly quotes: LinkValue<Text> };

const textAt = ({ link }: { readonly link: Link<unknown> }) => link as Link<Text>;

const plain: Schema<Value, PlainData> = encodeSchema({ fields: ["text"] }, fieldNames);
const quote: Schema<Value, QuoteData> = encodeSchema({ fields: ["quotes"] }, fieldNames);
const other = encodeSchema({ fields: "any" }, fieldNames);

const plainText: Implementation<Value, Text, PlainData> = {
  schema: plain,
  read: ({ link, data }) => ({ link, text: data.text }),
};
const quotedText: Implementation<Value, Text, QuoteData> = {
  schema: quote,
  async read({ link, data }, reader) {
    const quoted = await texts.read(data.quotes.link, reader);
    return { link, text: `"${quoted.text}"` };
  },
};
const texts = new Implementations(objectFormat, [plainText, quotedText]);

const hello = encodeObject(plain, { text: "hello" });
const echo = encodeObject(quote, { quotes: new LinkValue(textAt(hello)) });
const blobs = (...objects: { bytes: Uint8Array; link: Link<unknown> }[]) =>
  new Map(objects.map(({ bytes, link }) => [link, bytes]));

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
    const bytes = objectFormat.encode(objectFormat.object({ body: "hello" }, plain.link));
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
    expect(() => new Implementations(objectFormat, [plainText, { ...plainText }])).toThrow(
      `${plain.link} is given two implementations`,
    );
  });
});
