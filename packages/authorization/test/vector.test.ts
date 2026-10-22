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
  '{"data":{"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394","scheme":"ed25519"},' +
  '"schema":{"$link":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"}}';
const hotIdentityLink = "sha256:cb783cb52eb08afc8fa95ae721ca7c63eef4d7288efc82cf57b7bfa3aae946d8";
const authorizationText =
  '{"data":{"agent":{"$link":"sha256:cb783cb52eb08afc8fa95ae721ca7c63eef4d7288efc82cf57b7bfa3aae946d8"},' +
  '"until":"2027-01-01T00:00:00Z"},' +
  '"schema":{"$link":"sha256:29d18ca525b3221f6fd6f1624cd52fc61d1ffef55e377e9f891d32e16337399b"}}';
const authorizationLink = "sha256:99aca15ffdf55e7eae96a2e4bc31c9ff6012d54c852ffdbeb162c041641a5eb8";
const grantText =
  '{"data":{"identity":{"$link":"sha256:62abc6480cbadc8179cf05e5b19faa7e3db3e7ef531bccb66a22988d56c87e53"},' +
  '"object":{"$link":"sha256:99aca15ffdf55e7eae96a2e4bc31c9ff6012d54c852ffdbeb162c041641a5eb8"},' +
  '"signature":"204c40fd4b00978c516c50815252c87f4ac851063dd7d7be02a4a2e972c991be' +
  'e1424d04f74b52a1217145951e162953c79f1947ce97cedb41c584cb698cc302"},' +
  '"schema":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"}}';
const grantLink = "sha256:9d4391f85a64c04f64488f8440f3fec4ed2dd839a81d6299f69c8cad406f1daa";
const proxyText =
  '{"data":{"chain":[{"$link":"sha256:9d4391f85a64c04f64488f8440f3fec4ed2dd839a81d6299f69c8cad406f1daa"}],' +
  '"target":{"$link":"sha256:5d30573d533225e8de6a606e0531506022e16419cad6b1f735b21d3fffcc4d52"}},' +
  '"schema":{"$link":"sha256:ffa6bc8b7be6fa4f12b8be838f62e26eb0e083f1bc50398b422982e0a59dff71"}}';
const proxyLink = "sha256:8f92675bda591aff1c7ac40e7bf3737ae2032ae2c6e344c645f8dd36e13a7ceb";
const proxySignatureText =
  '{"data":{"identity":{"$link":"sha256:cb783cb52eb08afc8fa95ae721ca7c63eef4d7288efc82cf57b7bfa3aae946d8"},' +
  '"object":{"$link":"sha256:8f92675bda591aff1c7ac40e7bf3737ae2032ae2c6e344c645f8dd36e13a7ceb"},' +
  '"signature":"3e7f74c3e96aa5b70e2f15982c24874ac65c64140cad7ac2681a79a2896e0866' +
  'cd11fe739dc185a406a8670baea9b9e0a6621a8b7420960a0b621c72cc4ffb0a"},' +
  '"schema":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"}}';
const proxySignatureLink = "sha256:e854d7fc311beb767cbe9a394ca4f1e15f08267ee4f2ce1b720498574d87a93c";
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
