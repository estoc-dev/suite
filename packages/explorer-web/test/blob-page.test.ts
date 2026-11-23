import { markdownBodyOf, markdownBodySchema } from "@estoc/blog";
import {
  ed25519,
  eip191,
  loadIdentity,
  type Signature,
  SoftwareSigner,
  signatureSchema,
  solanaOffchain,
} from "@estoc/identity";
import { AbsentBlob, encodeObject, LinkValue, linkOf, ObjectValue, objectFormat } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { readBlobPage } from "../src/blob-page.ts";
import { bodyReading } from "../src/body-reading.tsx";
import { signatureReading } from "../src/signature-reading.tsx";
import { readerOf } from "./fixtures.ts";

const readingAt = async (bytes: Uint8Array, others: readonly Uint8Array[] = []) =>
  (await readBlobPage(readerOf(bytes, ...others), linkOf(bytes))).reading;

function bytesOf({ link, blobs }: Signature): Uint8Array {
  const bytes = blobs.find((blob) => linkOf(blob) === link);
  if (bytes === undefined) throw new Error(`the blobs of ${link} do not hold it`);
  return bytes;
}

const body = markdownBodyOf("## Identity\n");
const readBody = { link: body.link, html: "<h2>Identity</h2>\n" };

const schemes = [ed25519, eip191, solanaOffchain];
const { keys, publish, signatures } = loadIdentity(schemes);
const identityVersionInHand = async <T>(inHand: T) => inHand;
const root = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const agent = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2));
const signedIdentity = await publish(root, { agents: [agent.key], at: 1763078400000 });
const signature = await signatures.actor(agent, signedIdentity, identityVersionInHand).sign(body);

describe("the page of a blob", () => {
  it("holds what the reader gives for the link, read as an object where it is one", async () => {
    const reader = readerOf(body.bytes, ...markdownBodySchema.blobs);
    expect((await readBlobPage(reader, body.link)).inspection).toMatchObject({
      kind: "object",
      link: body.link,
      data: { text: "## Identity\n" },
      schema: { kind: "schema", link: markdownBodySchema.link, problems: [] },
    });
  });

  it("holds no reading for bytes that are not an object, and for a link with no blob", async () => {
    const bytes = Uint8Array.of(0, 10, 255);
    expect(await readBlobPage(readerOf(bytes), linkOf(bytes))).toEqual({
      inspection: { kind: "bytes", link: linkOf(bytes), bytes },
      reading: undefined,
    });
    expect(await readBlobPage(readerOf(), body.link)).toEqual({
      inspection: { kind: "absent", link: body.link },
      reading: undefined,
    });
  });
});

describe("the reading of a blob", () => {
  it("is the body that a Markdown body reads as", async () => {
    expect(await readingAt(body.bytes, markdownBodySchema.blobs)).toEqual({
      kind: "read",
      as: bodyReading,
      value: readBody,
    });
  });

  it("is the body where the reader has no blob for the schema of the body", async () => {
    expect(await readingAt(body.bytes)).toEqual({ kind: "read", as: bodyReading, value: readBody });
  });

  it("is none for an object of a schema of the same title that has another field", async () => {
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

  it.each(schemes)(
    "is the signature with who signed, by which key and over which object, where a $name key signed it",
    async (scheme) => {
      const root = SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(1));
      const agent = SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(2));
      const signedIdentity = await publish(root, { agents: [agent.key], at: 1763078400000 });
      const signature = await signatures.actor(agent, signedIdentity, identityVersionInHand).sign(body);
      expect(await readingAt(bytesOf(signature), signedIdentity.blobs)).toMatchObject({
        kind: "read",
        as: signatureReading,
        value: {
          link: signature.link,
          signedIdentity: { identity: { identifier: keys.encode(root.key).link } },
          key: { link: keys.encode(agent.key).link },
          object: body.link,
        },
      });
    },
  );

  it("is the signature where the reader gives a crisis that came after the identity version it carries", async () => {
    const crisis = await publish(root, { prior: signedIdentity, isCrisis: true, at: 1763164800000 });
    expect(await readingAt(bytesOf(signature), [...signedIdentity.blobs, ...crisis.blobs])).toMatchObject({
      kind: "read",
      as: signatureReading,
      value: { link: signature.link },
    });
  });

  it("is that the signature does not verify, for one whose bytes are altered", async () => {
    const bytes = signature.signature.map((byte, index) => (index === 1 ? byte ^ 1 : byte));
    const altered = encodeObject(signatureSchema, {
      signedIdentity: new LinkValue(signedIdentity.link),
      object: new LinkValue(signature.object),
      signature: bytes,
    });
    expect(await readingAt(altered.bytes, signedIdentity.blobs)).toEqual({
      kind: "unread",
      as: signatureReading,
      error: new Error(`the signature does not verify for ${body.link}`),
    });
  });

  it("is the link the reader gives no blob for, for a signature whose signed identity it lacks", async () => {
    const stranger = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(3));
    const unheldIdentity = await publish(stranger, { at: 1763078400000 });
    const unheldSignature = await signatures.actor(stranger, unheldIdentity, identityVersionInHand).sign(body);
    const reading = await readingAt(bytesOf(unheldSignature));
    expect(reading).toMatchObject({ kind: "unread", as: signatureReading, error: { link: unheldIdentity.link } });
    expect(reading).toHaveProperty("error", expect.any(AbsentBlob));
  });
});
