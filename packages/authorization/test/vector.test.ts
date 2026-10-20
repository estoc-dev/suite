import { SoftwareSigner } from "@estoc/identity";
import { encodeSchema, type EncodedObject, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { authorizationSchema, loadAuthorizations, proxySchema } from "../src/index.ts";

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and its
// hashlib; the signatures, which Ed25519 makes deterministic, against
// Python's cryptography package. A change to the format changes them.
const authorizationSchemaLink = "sha256:78173732851c348dd4dcab9768328653e3a92f416159f336b02766d9867dd81f";
const proxySchemaLink = "sha256:253128d1e4d26cf058819c2ed8fd533b955d036f270116c9f3307c88d91527a7";
const authorizationText =
  '{"data":{"agent":{"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394","scheme":"ed25519"},' +
  '"until":"2027-01-01T00:00:00Z"},' +
  '"schema":"sha256:78173732851c348dd4dcab9768328653e3a92f416159f336b02766d9867dd81f"}';
const authorizationLink = "sha256:7a77b58552a16e631f818f01a02747125fd9c54c14af690f3b324f013eea33c9";
const grantText =
  '{"identity":{"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c","scheme":"ed25519"},' +
  '"object":"sha256:7a77b58552a16e631f818f01a02747125fd9c54c14af690f3b324f013eea33c9",' +
  '"signature":"2138fbed8b264acc50c9b8175f6ed47386bc4edb1edf82c4abcc33dbbc61f602' +
  '5545f9cffaeb786e65c77d3d4eefbd1a1c9391df8e1b406c8cc3587f840e770b"}';
const grantLink = "sha256:8dea40d7b0904663cca604ccaa3bb5c00a4856ed0734c7cfa3196a9f80399de2";
const proxyText =
  '{"data":{"chain":["sha256:8dea40d7b0904663cca604ccaa3bb5c00a4856ed0734c7cfa3196a9f80399de2"],' +
  '"target":"sha256:65a66b9ddb1b8afe6fdc7d0c4ebef359b9c9657ce6712b82d1ba583dc159fb80"},' +
  '"schema":"sha256:253128d1e4d26cf058819c2ed8fd533b955d036f270116c9f3307c88d91527a7"}';
const proxyLink = "sha256:0b420580c9e72c13349be35eb676ecddcf45efb021edfc502d23f6352ba88c53";
const proxySignatureText =
  '{"identity":{"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394","scheme":"ed25519"},' +
  '"object":"sha256:0b420580c9e72c13349be35eb676ecddcf45efb021edfc502d23f6352ba88c53",' +
  '"signature":"9d40a94ffc2b783c46d64ddd77283d86bb3615e725c2c6c4bd10b89a8a8186b7' +
  'f776a14584ca7bf0e76adfe5accaee810dea27d82e529d55b720dec102c17404"}';
const proxySignatureLink = "sha256:4e64222715f20ff20c046b4230ff49e0bbb282937cf213c76f77c83445877704";

// The login object of the vector in @estoc/object.
const target: Link<EncodedObject> = "sha256:65a66b9ddb1b8afe6fdc7d0c4ebef359b9c9657ce6712b82d1ba583dc159fb80";
const root = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const hot = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(2));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);

const authorizations = await loadAuthorizations(defaultValidator);
const grant = await authorizations.authorize(hot.identity, root, "2027-01-01T00:00:00Z");
const proxy = await authorizations.proxy(target, [grant], hot);

describe("the two schemas, an Ed25519 authorization until 2027 and a proxy its agent signs", () => {
  it("encode to fixed bytes and links", async () => {
    expect((await encodeSchema(authorizationSchema, defaultValidator)).link).toBe(authorizationSchemaLink);
    expect((await encodeSchema(proxySchema, defaultValidator)).link).toBe(proxySchemaLink);
    expect(text(grant.object.bytes)).toBe(authorizationText);
    expect(grant.object.link).toBe(authorizationLink);
    expect(text(grant.signature.bytes)).toBe(grantText);
    expect(grant.signature.link).toBe(grantLink);
    expect(text(proxy.object.bytes)).toBe(proxyText);
    expect(proxy.object.link).toBe(proxyLink);
    expect(text(proxy.signature.bytes)).toBe(proxySignatureText);
    expect(proxy.signature.link).toBe(proxySignatureLink);
  });

  it("read from those bytes as the root standing behind the target through the agent", () => {
    const read = authorizations.readAuthorization(utf8(grantText), utf8(authorizationText));
    expect(read.authorizer).toEqual(root.identity);
    expect(read.agent).toEqual(hot.identity);
    const evidence = authorizations.evidenceFrom([authorizationText, grantText, proxyText, proxySignatureText].map(utf8));
    const standing = authorizations.standingBehind(target, evidence, new Date("2026-12-31T23:59:59Z"));
    expect(standing).toEqual([{ identity: root.identity, agents: [hot.identity] }]);
  });
});
