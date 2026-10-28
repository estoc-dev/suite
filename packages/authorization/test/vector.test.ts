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
  '{"$type":{"$link":"sha256:c8a75f0349805a6afaa44d44ea0787c048310934de9dc8565788f0f003014be5"},' +
  '"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394"}';
const hotIdentityLink = "sha256:b5a535ce0e23eaaebf51a283b1d19783b760857f558237dc78d61f6cd9a1d0d3";
const authorizationText =
  '{"$type":{"$link":"sha256:3eb52fc430c3498d03d3a00452acad920862a45d2e6ec6b525fd28e70968ecff"},' +
  '"agent":{"$link":"sha256:b5a535ce0e23eaaebf51a283b1d19783b760857f558237dc78d61f6cd9a1d0d3"}}';
const authorizationLink = "sha256:487e2fad115e914b1efe15b5820108ac8f6cbf5d88f9968f9fc708e3ecd0dcc9";
const grantText =
  '{"$type":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"},' +
  '"identity":{"$link":"sha256:25c90970d2a76cc7223d47405f04ec51fd5e0194020014bd6816652bc94383b8"},' +
  '"object":{"$link":"sha256:487e2fad115e914b1efe15b5820108ac8f6cbf5d88f9968f9fc708e3ecd0dcc9"},' +
  '"signature":"12fdc7b912b597d77d9f64b1ca33ccf7154662b8e1812b2d2db2046732a47338' +
  'f6d404afeddb7017a341a4c877a0ca97665d67c5408cdff0917ffa863ea12901"}';
const grantLink = "sha256:467931dc978c0b917d6bfc2af020cdc88bed675befd41fc6f0e5fdea6a02c3a6";
const proxyText =
  '{"$type":{"$link":"sha256:ffa6bc8b7be6fa4f12b8be838f62e26eb0e083f1bc50398b422982e0a59dff71"},' +
  '"chain":[{"$link":"sha256:467931dc978c0b917d6bfc2af020cdc88bed675befd41fc6f0e5fdea6a02c3a6"}],' +
  '"target":{"$link":"sha256:5fc34eb199031340371d48949ef89f64587acce9763e6bf38a6cd7d6b80b31de"}}';
const proxyLink = "sha256:3158ec9e90eaaa90bac3b56fb65c9340e94b3501b2d895eb62cd157042a20527";
const proxySignatureText =
  '{"$type":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"},' +
  '"identity":{"$link":"sha256:b5a535ce0e23eaaebf51a283b1d19783b760857f558237dc78d61f6cd9a1d0d3"},' +
  '"object":{"$link":"sha256:3158ec9e90eaaa90bac3b56fb65c9340e94b3501b2d895eb62cd157042a20527"},' +
  '"signature":"db43ade4122e3a019615d030c2416b337fc0d65c12317aad10d137db4c23a1d6' +
  '3ab1af3b9f29fc6881e961ed4878848ba727af84c8e75e46dca0e16d5f278507"}';
const proxySignatureLink = "sha256:7aa44c8fb597a5b95a3144fe09d23768dd016e8d517bb82cbb492c65e0a7ee70";
// The identity object of the signer of the vector in @estoc/identity.
const rootIdentityText =
  '{"$type":{"$link":"sha256:c8a75f0349805a6afaa44d44ea0787c048310934de9dc8565788f0f003014be5"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';

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
