import { createHash } from "node:crypto";
import { hexToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import {
  AbsentBlob,
  blobsOf,
  decodeObject,
  decodeSchema,
  encodeObject,
  encodeSchema,
  LinkValue,
  linkOf,
  namedSchemaAt,
  ObjectValue,
  objectFormat,
  objectsOf,
  objectValueAt,
  readObject,
  schemaOf,
  type ValueMap,
} from "../src/index.ts";
import { documentHolding, schemaTaking } from "./documents.ts";

const login = encodeSchema(documentHolding("Login", "audience", "nonce"));
const anything = schemaTaking("audience", "nonce", "array", "string", "link", "bytes", "$schema", "schema");
const greeting = { audience: "https://app.estoc.dev", nonce: "6f1c" };
const malformed: [string, Uint8Array][] = [
  ["of no bytes", new Uint8Array()],
  ["that is a map under no tag", hexToBytes("a0")],
  ["that is a link under no tag", hexToBytes(`d9486c5820${anything.link.slice("sha256:".length)}`)],
  ["written in JSON", new TextEncoder().encode(`{"$schema":{"$link":"${anything.link}"},"v":1}`)],
];

describe("an object", () => {
  it.each<[string, ValueMap]>([
    ["fields", greeting],
    [
      "fields of every kind",
      { array: [1, "two", { three: true }], string: "hello", link: new LinkValue(login.link), bytes: Uint8Array.of(1) },
    ],
    ["no fields", {}],
    ["a field of any name, as it keeps none for its schema", { $schema: "note", schema: new LinkValue(login.link) }],
  ])("holding %s reads back with the same link", (_, data) => {
    const object = encodeObject(anything, data);
    const read = decodeObject(object.bytes, anything);
    expect(read.data).toEqual(data);
    expect(read.link).toBe(object.link);
    expect(read.schema).toBe(anything);
  });

  it("is encoded to bytes over an `ArrayBuffer`, which a socket of a browser sends as they are", () => {
    const bytes: Uint8Array<ArrayBuffer> = encodeObject(anything, greeting).bytes;
    expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
  });

  it("is linked by the SHA-256 of its bytes", () => {
    const object = encodeObject(login, greeting);
    expect(object.link).toBe(`sha256:${createHash("sha256").update(object.bytes).digest("hex")}`);
  });

  it("under another schema is another object", () => {
    expect(encodeObject(anything, greeting).link).not.toBe(encodeObject(login, greeting).link);
  });

  it("is refused when its data does not fit its schema", () => {
    expect(() => encodeObject(login, { audience: "https://app.estoc.dev" })).toThrow();
    const bytes = encodeObject(anything, { audience: "https://app.estoc.dev" }).bytes;
    expect(() => decodeObject(bytes, login)).toThrow();
  });

  it("is refused when read with a schema other than its own, even one its data fits", () => {
    expect(() => decodeObject(encodeObject(login, greeting).bytes, anything)).toThrow();
  });

  it.each(malformed)("is refused %s", (_, bytes) => {
    expect(() => decodeObject(bytes, anything)).toThrow();
  });
});

test("the blobs of an object are the object and the blobs of its schema", () => {
  const object = encodeObject(login, greeting);
  expect(blobsOf(object)).toEqual([object.bytes, ...login.blobs]);
});

describe("an object read by its link", () => {
  const object = encodeObject(login, greeting);

  it("is the object whose blob the reader gives for the link", async () => {
    expect(await readObject(new Map([[object.link, object.bytes]]), object.link, login)).toEqual(object);
  });

  it("is refused when the reader gives no blob for the link, by an error that has the link", async () => {
    const reading = readObject(new Map(), object.link, login);
    await expect(reading).rejects.toBeInstanceOf(AbsentBlob);
    await expect(reading).rejects.toMatchObject({ link: object.link });
  });

  it("is refused when the reader gives another blob for the link", async () => {
    const other = encodeObject(login, { ...greeting, nonce: "9a2e" });
    await expect(readObject(new Map([[object.link, other.bytes]]), object.link, login)).rejects.toThrow(
      /is another blob/,
    );
  });
});

describe("what a blob decodes to", () => {
  // Written out by hand, so that nothing has decoded them before the test does.
  const written = (nonce: string) => objectFormat.encode(new ObjectValue(login.link, { ...greeting, nonce }));

  afterEach(() => vi.restoreAllMocks());

  it("is kept under its link, so that while it is kept the blob is decoded and validated once however it is read", async () => {
    const bytes = written("read four ways");
    const link = linkOf(bytes);
    const decode = vi.spyOn(objectFormat, "decode");
    const validate = vi.spyOn(login, "validate");
    expect(namedSchemaAt(link, bytes)).toBe(login.link);
    expect(objectValueAt(link, bytes).data).toEqual({ ...greeting, nonce: "read four ways" });
    expect(decodeObject(bytes, login).link).toBe(link);
    expect((await readObject(new Map([[link, bytes]]), link, login)).link).toBe(link);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("is not kept under the link of another blob", () => {
    const [bytes, other] = [written("given for another"), written("asked for")];
    expect(() => objectValueAt(linkOf(other), bytes)).toThrow(/is another blob/);
    expect(namedSchemaAt(linkOf(other), bytes)).toBeUndefined();
    expect(objectValueAt(linkOf(other), other).data).toMatchObject({ nonce: "asked for" });
  });

  it("is what its link names once it is kept, whatever bytes are given with the link", () => {
    const [bytes, other] = [written("kept"), written("given later")];
    objectValueAt(linkOf(bytes), bytes);
    expect(objectValueAt(linkOf(bytes), other).data).toMatchObject({ nonce: "kept" });
  });

  test("a blob whose data does not fit its schema is refused each time it is read", () => {
    const bytes = objectFormat.encode(new ObjectValue(login.link, { audience: 1 }));
    expect(() => decodeObject(bytes, login)).toThrow(/does not fit its schema/);
    expect(() => decodeObject(bytes, login)).toThrow(/does not fit its schema/);
  });

  describe("of a blob with many bytes in it", () => {
    const attachment = encodeSchema({
      title: "Attachment",
      fields: { name: { type: "string" }, bytes: { type: "bytes" } },
    });
    const MiB = 1024 * 1024;
    const writtenWith = (name: string, length: number) =>
      objectFormat.encode(new ObjectValue(attachment.link, { name, bytes: new Uint8Array(length) }));

    it("is kept until the blobs read after it are longer together than what is kept", () => {
      const [first, second, third] = [
        writtenWith("first", 12 * MiB),
        writtenWith("second", 12 * MiB),
        writtenWith("third", 12 * MiB),
      ];
      for (const bytes of [first, second, third]) decodeObject(bytes, attachment);
      const decode = vi.spyOn(objectFormat, "decode");
      expect(decodeObject(third, attachment).data.name).toBe("third");
      expect(decode).not.toHaveBeenCalled();
      expect(decodeObject(first, attachment).data.name).toBe("first");
      expect(decode).toHaveBeenCalledTimes(1);
    });

    it("is not kept where the blob alone is longer than that, and is read as any other", () => {
      const bytes = writtenWith("alone", 33 * MiB);
      const decode = vi.spyOn(objectFormat, "decode");
      expect(decodeObject(bytes, attachment).data.name).toBe("alone");
      expect(decodeObject(bytes, attachment).data.name).toBe("alone");
      expect(decode).toHaveBeenCalledTimes(2);
    });
  });
});

describe("the schema an object names", () => {
  it("is read without the schema, whether or not the data fits it", () => {
    expect(schemaOf(encodeObject(login, greeting).bytes)).toBe(login.link);
    expect(schemaOf(objectFormat.encode(new ObjectValue(login.link, { v: 1 })))).toBe(login.link);
  });

  it.each(malformed)("is not read from an object %s", (_, bytes) => {
    expect(() => schemaOf(bytes)).toThrow();
  });
});

describe("a selection by schema", () => {
  it("takes the objects of its schema, and none of another", async () => {
    const object = encodeObject(login, greeting);
    const reader = { get: async () => object.bytes };
    expect(await objectsOf(login).read(object.link, reader)).toEqual(object);
    expect(await objectsOf(anything).read(object.link, reader)).toBeUndefined();
  });

  it.each(malformed)("takes no blob %s", async (_, bytes) => {
    expect(await objectsOf(login).read(linkOf(bytes), { get: async () => bytes })).toBeUndefined();
  });
});

test("an object read with a schema decoded from the same bytes keeps its link", () => {
  const object = encodeObject(login, greeting);
  const schema = decodeSchema(login.bytes);
  expect(decodeObject(object.bytes, schema).link).toBe(object.link);
});
