import { markdownBodyOf, markdownBodySchema } from "@estoc/blog";
import { ed25519, loadIdentity, SoftwareSigner, signatureSchema } from "@estoc/identity";
import { inspect } from "@estoc/inspector";
import { AbsentBlob, encodeObject, type Link, linkOf, ObjectValue, objectFormat } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { bodyReading } from "../src/body-reading.ts";
import { readingOf } from "../src/reading.ts";
import { readings } from "../src/readings.ts";
import { signatureReading } from "../src/signature-reading.ts";

const readerOf = (blobs: readonly Uint8Array[]) =>
  new Map<Link<unknown>, Uint8Array>(blobs.map((blob) => [linkOf(blob), blob]));

async function readingAt(bytes: Uint8Array, others: readonly Uint8Array[] = []) {
  const reader = readerOf([bytes, ...others]);
  return readingOf(await inspect(linkOf(bytes), reader), reader, readings);
}

const body = markdownBodyOf("## Identity\n");

const { keys, publish, signatures } = loadIdentity([ed25519]);
const root = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const agent = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2));
const signedIdentity = await publish(root, { agents: [agent.key], at: 1763078400000 });
const signature = await signatures.actor(agent, signedIdentity).sign(body);

describe("the reading of what a link reads as", () => {
  it("is the body that a Markdown body reads as", async () => {
    expect(await readingAt(body.bytes, markdownBodySchema.blobs)).toEqual({
      kind: "read",
      as: bodyReading,
      value: body,
    });
  });

  it("is the body where the reader has no blob for the schema of the body", async () => {
    expect(await readingAt(body.bytes)).toEqual({ kind: "read", as: bodyReading, value: body });
  });

  it("is nothing for an object of a schema of the same title that has another field", async () => {
    const lookalike = schema("Markdown Body", { text: string(), more: string() });
    const { bytes } = encodeObject(lookalike, { text: "## Identity\n", more: "" });
    expect(await readingAt(bytes, lookalike.blobs)).toBeUndefined();
  });

  it("is what does not fit, for a body whose data does not fit its schema", async () => {
    const misfit = objectFormat.encode(new ObjectValue(markdownBodySchema.link, { text: 7 }));
    const expectedReading = {
      kind: "unread",
      as: bodyReading,
      error: new Error("the data does not fit its schema: #/text: not a string"),
    };
    expect(await readingAt(misfit, markdownBodySchema.blobs)).toEqual(expectedReading);
    expect(await readingAt(misfit)).toEqual(expectedReading);
  });

  it("is nothing for bytes that are not an object, and for a link with no blob", async () => {
    expect(await readingAt(Uint8Array.of(0, 10, 255))).toBeUndefined();
    expect(await readingOf(await inspect(body.link, readerOf([])), readerOf([]), readings)).toBeUndefined();
  });

  it("is the signature with who signed, by which key and over which object, where it verifies", async () => {
    expect(await readingAt(signature.bytes, signedIdentity.blobs)).toMatchObject({
      kind: "read",
      as: signatureReading,
      value: {
        link: linkOf(signature.bytes),
        signedIdentity: { identity: { identifier: keys.encode(root.key).link } },
        key: { link: keys.encode(agent.key).link },
        object: body.link,
      },
    });
  });

  it("is the link the reader gives no blob for, for a signature whose signed identity it lacks", async () => {
    const reading = await readingAt(signature.bytes);
    expect(reading).toMatchObject({ kind: "unread", as: signatureReading, error: { link: signedIdentity.link } });
    expect(reading).toHaveProperty("error", expect.any(AbsentBlob));
  });

  it("is that the signature does not verify, for one whose bytes are altered", async () => {
    const bytes = signature.signature.map((byte, index) => (index === 1 ? byte ^ 1 : byte));
    const altered = encodeObject(signatureSchema, { ...signature.data, signature: bytes });
    expect(await readingAt(altered.bytes, signedIdentity.blobs)).toEqual({
      kind: "unread",
      as: signatureReading,
      error: new Error(`the signature does not verify for ${body.link}`),
    });
  });
});
