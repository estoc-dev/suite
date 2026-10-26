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
const authorizationSchemaLink = "sha256:29d18ca525b3221f6fd6f1624cd52fc61d1ffef55e377e9f891d32e16337399b";
const proxySchemaLink = "sha256:ffa6bc8b7be6fa4f12b8be838f62e26eb0e083f1bc50398b422982e0a59dff71";
const hotIdentityText =
  '{"$type":{"$link":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"},' +
  '"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394","scheme":"ed25519"}';
const hotIdentityLink = "sha256:f5c09c4a0efac2d47552a5b03ce75ab7762d3ca149cc9b1355f33101dea495a0";
const authorizationText =
  '{"$type":{"$link":"sha256:29d18ca525b3221f6fd6f1624cd52fc61d1ffef55e377e9f891d32e16337399b"},' +
  '"agent":{"$link":"sha256:f5c09c4a0efac2d47552a5b03ce75ab7762d3ca149cc9b1355f33101dea495a0"},' +
  '"until":"2027-01-01T00:00:00Z"}';
const authorizationLink = "sha256:7baf6e34fc1fc792dc9355e6d2e7586c7da4d6e89b430302ebab5f0789f9e3ba";
const grantText =
  '{"$type":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"},' +
  '"identity":{"$link":"sha256:3d52c9daa7ce3a7b07d4f155e33b08374b14e82f3d05c14f718d64d3552d6e1c"},' +
  '"object":{"$link":"sha256:7baf6e34fc1fc792dc9355e6d2e7586c7da4d6e89b430302ebab5f0789f9e3ba"},' +
  '"signature":"2ef003b374f2efa8a7046cd656bd0b3cee69aef70998aa452459ce3c9b5ad3a7' +
  '0971b97d27c5aabb72950edeccc4acbbc5fec1fcfff01436b89d5ee80c78e703"}';
const grantLink = "sha256:a5677034aa2c8cd9cd546169744f26b448c19485aa29fc06f583fa503bc0fed6";
const proxyText =
  '{"$type":{"$link":"sha256:ffa6bc8b7be6fa4f12b8be838f62e26eb0e083f1bc50398b422982e0a59dff71"},' +
  '"chain":[{"$link":"sha256:a5677034aa2c8cd9cd546169744f26b448c19485aa29fc06f583fa503bc0fed6"}],' +
  '"target":{"$link":"sha256:5fc34eb199031340371d48949ef89f64587acce9763e6bf38a6cd7d6b80b31de"}}';
const proxyLink = "sha256:98bfce88823ed9f95cac72d528145e106a43fe0deca341a5968a0e08de8f2e49";
const proxySignatureText =
  '{"$type":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"},' +
  '"identity":{"$link":"sha256:f5c09c4a0efac2d47552a5b03ce75ab7762d3ca149cc9b1355f33101dea495a0"},' +
  '"object":{"$link":"sha256:98bfce88823ed9f95cac72d528145e106a43fe0deca341a5968a0e08de8f2e49"},' +
  '"signature":"f5352d492d92b96a6bed2f72d57111a56d20f62be669a4badae3e68af253da96' +
  '73b5ac9f20d87a1110c735b57064cd380970e5a78a9193c31a774652aecb7f09"}';
const proxySignatureLink = "sha256:5643b184903b998a18fe0da8cb070a2ddeb548c7de4cd867dfab7b8437b9aed3";
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
const grant = await authorizations.authorize(hot.identity, root, Temporal.Instant.from("2027-01-01T00:00:00Z"));
const entry = await authorizations.createActor(hot, [grant]).sign(target);
const proxy = entry.blobs.find((blob) => linkOf(blob) === entry.signature.object)!;

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
    const standing = await authorizations.readStanding(target, proxySignatureLink, blobs, new Date("2026-12-31T23:59:59Z"));
    expect(standing).toEqual({ principal: identities.encode(root.identity), agents: [identities.encode(hot.identity)] });
  });
});
