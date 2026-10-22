import { SoftwareSigner } from "@estoc/identity";
import { encodeSchema, linkOf, type EncodedObject, type Json, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { authorizationSchema, loadAuthorizations, proxySchema } from "../src/index.ts";

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and its
// hashlib; the signatures, which Ed25519 makes deterministic, against
// Python's cryptography package. A change to the format changes them.
const authorizationSchemaLink = "sha256:d29870e078e52da1b055d4536adaa856a1b717f3e3fd5e3480e8b190c2b708ca";
const proxySchemaLink = "sha256:121a2faacf1b07855a59863ad6a9f0d38f45472b6a5b563fc30a8169b6de5903";
const hotIdentityText =
  '{"data":{"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394","scheme":"ed25519"},' +
  '"schema":{"$link":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"}}';
const hotIdentityLink = "sha256:cb783cb52eb08afc8fa95ae721ca7c63eef4d7288efc82cf57b7bfa3aae946d8";
const authorizationText =
  '{"data":{"agent":{"$link":"sha256:cb783cb52eb08afc8fa95ae721ca7c63eef4d7288efc82cf57b7bfa3aae946d8"},' +
  '"until":"2027-01-01T00:00:00Z"},' +
  '"schema":{"$link":"sha256:d29870e078e52da1b055d4536adaa856a1b717f3e3fd5e3480e8b190c2b708ca"}}';
const authorizationLink = "sha256:ae1d5e3eda5ddd8dd0493549312b2481600d8858fd666be9d9e9154cbc5f5678";
const grantText =
  '{"data":{"identity":{"$link":"sha256:62abc6480cbadc8179cf05e5b19faa7e3db3e7ef531bccb66a22988d56c87e53"},' +
  '"object":{"$link":"sha256:ae1d5e3eda5ddd8dd0493549312b2481600d8858fd666be9d9e9154cbc5f5678"},' +
  '"signature":"c76a7cbcc26b5588909984c94e5a918a1874b8304e0cfabd8805deaa4d2775cd' +
  '67af919fc7d78f079a9e5947fdb4400f05504b848a8e6a121af46ba17b4ac30b"},' +
  '"schema":{"$link":"sha256:c44f0f4d7177466d11b3a2080f717a9846a9ccf6899c11c0657e37f067c22472"}}';
const grantLink = "sha256:f9f42b3461a381a68bd026518f38b5a71107729e491980202e3f47cc3611294f";
const proxyText =
  '{"data":{"chain":[{"$link":"sha256:f9f42b3461a381a68bd026518f38b5a71107729e491980202e3f47cc3611294f"}],' +
  '"target":{"$link":"sha256:5d30573d533225e8de6a606e0531506022e16419cad6b1f735b21d3fffcc4d52"}},' +
  '"schema":{"$link":"sha256:121a2faacf1b07855a59863ad6a9f0d38f45472b6a5b563fc30a8169b6de5903"}}';
const proxyLink = "sha256:aba4a05568edc1f7ae321ccb1dbdf78068973ca05d09ca8c2fd99eacad298239";
const proxySignatureText =
  '{"data":{"identity":{"$link":"sha256:cb783cb52eb08afc8fa95ae721ca7c63eef4d7288efc82cf57b7bfa3aae946d8"},' +
  '"object":{"$link":"sha256:aba4a05568edc1f7ae321ccb1dbdf78068973ca05d09ca8c2fd99eacad298239"},' +
  '"signature":"48ade88ecdf99476ee1101493bec65b988d9e250324642e48712e0a9618d2dd1' +
  '276b89629725d42086b13d23dc13250a0e8b42f310edb037f943576e66651e08"},' +
  '"schema":{"$link":"sha256:c44f0f4d7177466d11b3a2080f717a9846a9ccf6899c11c0657e37f067c22472"}}';
const proxySignatureLink = "sha256:c7b727252570ff87514b16c21cc87b1d7a5e983414ea869d33419cdcdddb26cc";
// The identity object of the signer of the vector in @estoc/object.
const rootIdentityText =
  '{"data":{"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c","scheme":"ed25519"},' +
  '"schema":{"$link":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"}}';

// The login object of the vector in @estoc/object.
const target: Link<EncodedObject<Json>> = "sha256:5d30573d533225e8de6a606e0531506022e16419cad6b1f735b21d3fffcc4d52";
const root = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const hot = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(2));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);

const authorizations = await loadAuthorizations(defaultValidator);
const { identities } = authorizations.signatures;
const grant = await authorizations.authorize(hot.identity, root, Temporal.Instant.from("2027-01-01T00:00:00Z"));
const proxy = await authorizations.proxy(target, [grant], hot);

describe("the two schemas, an Ed25519 authorization until 2027 and a proxy its agent signs", () => {
  it("encode to fixed bytes and links", async () => {
    expect((await encodeSchema(authorizationSchema, defaultValidator)).link).toBe(authorizationSchemaLink);
    expect((await encodeSchema(proxySchema, defaultValidator)).link).toBe(proxySchemaLink);
    expect(text(grant.object.agent.bytes)).toBe(hotIdentityText);
    expect(grant.object.agent.link).toBe(hotIdentityLink);
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
    const texts = [rootIdentityText, hotIdentityText, authorizationText, grantText, proxyText];
    const blobs = new Map<string, Uint8Array>(texts.map((text) => [linkOf(utf8(text)), utf8(text)]));
    const read = authorizations.readAuthorization(utf8(grantText), blobs);
    expect(read.signature.identity).toEqual(identities.encode(root.identity));
    expect(read.object.agent).toEqual(identities.encode(hot.identity));
    const standing = authorizations.readStanding(target, utf8(proxySignatureText), blobs, new Date("2026-12-31T23:59:59Z"));
    expect(standing).toEqual({ identity: identities.encode(root.identity), agents: [identities.encode(hot.identity)] });
  });
});
