import { SoftwareSigner } from "@estoc/identity";
import { type EncodedObject, encodeSchema, type Json, type Link, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { assert, describe, expect, it } from "vitest";
import { authorizationSchema, loadAuthorizations, proxySchema } from "../src/index.ts";

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and its
// hashlib; the signatures, which Ed25519 makes deterministic, against
// Python's cryptography package. A change to the format changes them.
const authorizationSchemaLink = "sha256:3eb52fc430c3498d03d3a00452acad920862a45d2e6ec6b525fd28e70968ecff";
const proxySchemaLink = "sha256:ffa6bc8b7be6fa4f12b8be838f62e26eb0e083f1bc50398b422982e0a59dff71";
const hotIdentityText =
  '{"$type":{"$link":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"},' +
  '"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394","scheme":"ed25519"}';
const hotIdentityLink = "sha256:f5c09c4a0efac2d47552a5b03ce75ab7762d3ca149cc9b1355f33101dea495a0";
const authorizationText =
  '{"$type":{"$link":"sha256:3eb52fc430c3498d03d3a00452acad920862a45d2e6ec6b525fd28e70968ecff"},' +
  '"agent":{"$link":"sha256:f5c09c4a0efac2d47552a5b03ce75ab7762d3ca149cc9b1355f33101dea495a0"}}';
const authorizationLink = "sha256:afa01a1682019e1c745db33d04c044722a7599be59a416bf1b9b09ade5879aba";
const grantText =
  '{"$type":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"},' +
  '"identity":{"$link":"sha256:3d52c9daa7ce3a7b07d4f155e33b08374b14e82f3d05c14f718d64d3552d6e1c"},' +
  '"object":{"$link":"sha256:afa01a1682019e1c745db33d04c044722a7599be59a416bf1b9b09ade5879aba"},' +
  '"signature":"12fdbffceedb0d469e69a87bf6030bb4209dc0d72fa3817bcd585596a2e75826' +
  '0840697907759c044f5f3280d5a6bc6f031b5f5259185db714a832a3b95f2b0f"}';
const grantLink = "sha256:de9010ea192eeb4fef4dbfab705584af3594fbd95911b9a2ed531a65c3a42fa4";
const proxyText =
  '{"$type":{"$link":"sha256:ffa6bc8b7be6fa4f12b8be838f62e26eb0e083f1bc50398b422982e0a59dff71"},' +
  '"chain":[{"$link":"sha256:de9010ea192eeb4fef4dbfab705584af3594fbd95911b9a2ed531a65c3a42fa4"}],' +
  '"target":{"$link":"sha256:5fc34eb199031340371d48949ef89f64587acce9763e6bf38a6cd7d6b80b31de"}}';
const proxyLink = "sha256:b38c69af12bad5cef9239d2f07ee5bdc53f41d06031b3854f8380185b5b786fb";
const proxySignatureText =
  '{"$type":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"},' +
  '"identity":{"$link":"sha256:f5c09c4a0efac2d47552a5b03ce75ab7762d3ca149cc9b1355f33101dea495a0"},' +
  '"object":{"$link":"sha256:b38c69af12bad5cef9239d2f07ee5bdc53f41d06031b3854f8380185b5b786fb"},' +
  '"signature":"b8fbe49ef6600629ab3d178742117b3e7a0f75969c11cba8519b93dbad8fad69' +
  'ec4585b41d795c5d0db8a3676793ea6b9028cc5e450a4b8b217dc3c8000a4606"}';
const proxySignatureLink = "sha256:a0bad411afc1cbef3e61fcfe39c19ac70febff4f51c94fb0e4e0124d1d547677";
// The identity object of the signer of the vector in @estoc/object.
const rootIdentityText =
  '{"$type":{"$link":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c","scheme":"ed25519"}';

// The login object of the vector in @estoc/object.
const target: Link<EncodedObject<Json>> = "sha256:5fc34eb199031340371d48949ef89f64587acce9763e6bf38a6cd7d6b80b31de";
const root = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const hot = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(2));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);

const authorizations = await loadAuthorizations(defaultValidator);
const { identities } = authorizations.signatures;
const grant = await authorizations.authorize(hot.identity, root);
const entry = await authorizations.createActor(hot, [grant]).sign(target);
const proxy = entry.blobs.find((blob) => linkOf(blob) === entry.signature.object);
assert.exists(proxy);

describe("the two schemas, an Ed25519 authorization and a proxy its agent signs", () => {
  it("encode to fixed bytes and links", async () => {
    expect((await encodeSchema(authorizationSchema, defaultValidator)).link).toBe(authorizationSchemaLink);
    expect((await encodeSchema(proxySchema, defaultValidator)).link).toBe(proxySchemaLink);
    expect(text(grant.object.agent.bytes)).toBe(hotIdentityText);
    expect(grant.object.agent.link).toBe(hotIdentityLink);
    expect(text(grant.object.bytes)).toBe(authorizationText);
    expect(grant.object.link).toBe(authorizationLink);
    expect(text(grant.signature.bytes)).toBe(grantText);
    expect(grant.signature.link).toBe(grantLink);
    expect(text(proxy)).toBe(proxyText);
    expect(entry.signature.object).toBe(proxyLink);
    expect(text(entry.signature.bytes)).toBe(proxySignatureText);
    expect(entry.signature.link).toBe(proxySignatureLink);
  });

  it("read from those bytes as the root standing behind the target through the agent", async () => {
    const texts = [rootIdentityText, hotIdentityText, authorizationText, grantText, proxyText, proxySignatureText];
    const blobs = new Map<string, Uint8Array>(texts.map((text) => [linkOf(utf8(text)), utf8(text)]));
    const read = await authorizations.readAuthorization(grantLink, blobs);
    expect(read.signature.identity).toEqual(identities.encode(root.identity));
    expect(read.object.agent).toEqual(identities.encode(hot.identity));
    const standing = await authorizations.readStanding(target, proxySignatureLink, blobs);
    expect(standing).toEqual({
      principal: identities.encode(root.identity),
      agents: [identities.encode(hot.identity)],
    });
  });
});
