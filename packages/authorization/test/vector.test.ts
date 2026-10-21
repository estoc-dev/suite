import { SoftwareSigner } from "@estoc/identity";
import { encodeIdentity, encodeSchema, linkOf, type EncodedObject, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { authorizationSchema, loadAuthorizations, proxySchema } from "../src/index.ts";

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and its
// hashlib; the signatures, which Ed25519 makes deterministic, against
// Python's cryptography package. A change to the format changes them.
const authorizationSchemaLink = "sha256:4e959cb410a6a1b0758521bc98a63c5e3dac0a30dd8c9e6d174906fdabf8f817";
const proxySchemaLink = "sha256:253128d1e4d26cf058819c2ed8fd533b955d036f270116c9f3307c88d91527a7";
const hotIdentityText =
  '{"data":{"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394","scheme":"ed25519"},' +
  '"schema":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"}';
const hotIdentityLink = "sha256:c7e4b74d0e076b9bde19b3410419f691885b304a4f62f998476a92b691b36938";
const authorizationText =
  '{"data":{"agent":"sha256:c7e4b74d0e076b9bde19b3410419f691885b304a4f62f998476a92b691b36938",' +
  '"until":"2027-01-01T00:00:00Z"},' +
  '"schema":"sha256:4e959cb410a6a1b0758521bc98a63c5e3dac0a30dd8c9e6d174906fdabf8f817"}';
const authorizationLink = "sha256:74444088fb9d1676fa7d126b7f8140e1059b9916568bec098ffbfa07aebc55cd";
const grantText =
  '{"data":{"identity":"sha256:5a5b174f0d65db60322fdf504eaad099064bb0046a102ef013d6dd171fc8eecc",' +
  '"object":"sha256:74444088fb9d1676fa7d126b7f8140e1059b9916568bec098ffbfa07aebc55cd",' +
  '"signature":"7e09d57bb0e6822992a76f51f9f8ef5f42b9ad45340e699dabb413d0492527ee' +
  '01ed988784eba364d852e95e331907a6bca47bcb546251aad5d1a28d14662d09"},' +
  '"schema":"sha256:8f7d89a00e6e281562fa88c0632f6e350b68fe09fdd6f14edcb61e697a9ef777"}';
const grantLink = "sha256:73b08e2853e9993262bcdc16cb9ceecdfcd28537f405ef5afbb2b2981f228303";
const proxyText =
  '{"data":{"chain":["sha256:73b08e2853e9993262bcdc16cb9ceecdfcd28537f405ef5afbb2b2981f228303"],' +
  '"target":"sha256:65a66b9ddb1b8afe6fdc7d0c4ebef359b9c9657ce6712b82d1ba583dc159fb80"},' +
  '"schema":"sha256:253128d1e4d26cf058819c2ed8fd533b955d036f270116c9f3307c88d91527a7"}';
const proxyLink = "sha256:6907d9b8def2f00366594ee65ae6b87ed8ce3bc608c7e7aac95f3bd13c4ed639";
const proxySignatureText =
  '{"data":{"identity":"sha256:c7e4b74d0e076b9bde19b3410419f691885b304a4f62f998476a92b691b36938",' +
  '"object":"sha256:6907d9b8def2f00366594ee65ae6b87ed8ce3bc608c7e7aac95f3bd13c4ed639",' +
  '"signature":"0e698768d158791820745acb51720c134c0f80bb4fda0ab98307e9180b65be89' +
  '488234c3016b47dbe457b63f8cf0ab908b99ff5d6761e42b7ae0dabfa9adb30c"},' +
  '"schema":"sha256:8f7d89a00e6e281562fa88c0632f6e350b68fe09fdd6f14edcb61e697a9ef777"}';
const proxySignatureLink = "sha256:76d926ee35454f5eac493245260ebaa0674641b6366a352239b4dc8469b2d3de";
// The identity object of the signer of the vector in @estoc/object.
const rootIdentityText =
  '{"data":{"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c","scheme":"ed25519"},' +
  '"schema":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"}';

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
    expect(read.signature.identity).toEqual(encodeIdentity(root.identity));
    expect(read.object.agent).toEqual(encodeIdentity(hot.identity));
    const standing = authorizations.readStanding(target, utf8(proxySignatureText), blobs, new Date("2026-12-31T23:59:59Z"));
    expect(standing).toEqual({ identity: encodeIdentity(root.identity), agents: [encodeIdentity(hot.identity)] });
  });
});
