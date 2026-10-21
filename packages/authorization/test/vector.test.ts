import { SoftwareSigner } from "@estoc/identity";
import { encodeIdentity, encodeSchema, linkOf, type EncodedObject, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { authorizationSchema, loadAuthorizations, proxySchema } from "../src/index.ts";

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and its
// hashlib; the signatures, which Ed25519 makes deterministic, against
// Python's cryptography package. A change to the format changes them.
const authorizationSchemaLink = "sha256:b36d497af7578c8e0b3c5d19d483d95edbfd53415cd5287c7d50f48bd0529b5c";
const proxySchemaLink = "sha256:b0e10849403c45c4a5dc0d94c0c661958cbf7fc9992aad3e48b61d4c7c6fe5a6";
const hotIdentityText =
  '{"data":{"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394","scheme":"ed25519"},' +
  '"schema":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"}';
const hotIdentityLink = "sha256:c7e4b74d0e076b9bde19b3410419f691885b304a4f62f998476a92b691b36938";
const authorizationText =
  '{"data":{"agent":"sha256:c7e4b74d0e076b9bde19b3410419f691885b304a4f62f998476a92b691b36938",' +
  '"until":"2027-01-01T00:00:00Z"},' +
  '"schema":"sha256:b36d497af7578c8e0b3c5d19d483d95edbfd53415cd5287c7d50f48bd0529b5c"}';
const authorizationLink = "sha256:05378365319c825c6950e4821cd880ee01c8bf07afda428a2ae6ff93f2b4f096";
const grantText =
  '{"data":{"identity":"sha256:5a5b174f0d65db60322fdf504eaad099064bb0046a102ef013d6dd171fc8eecc",' +
  '"object":"sha256:05378365319c825c6950e4821cd880ee01c8bf07afda428a2ae6ff93f2b4f096",' +
  '"signature":"713fef24f45dacb13b882e3e42e7f830eb1982a5466552b2f3cb0b0b0312497a' +
  '12bfc03dfebebf0d480248a39c2773ba8f2ed0292c6f74fb57824128b2533f03"},' +
  '"schema":"sha256:05b7d8cb16217903e90fbbae01bd0fdf157d10a9829fb22f2729c2e836495506"}';
const grantLink = "sha256:fd5f32186ed4e179c68fc6cff324c68150564dea986b5570aac9fc6be4dae4ce";
const proxyText =
  '{"data":{"chain":["sha256:fd5f32186ed4e179c68fc6cff324c68150564dea986b5570aac9fc6be4dae4ce"],' +
  '"target":"sha256:65a66b9ddb1b8afe6fdc7d0c4ebef359b9c9657ce6712b82d1ba583dc159fb80"},' +
  '"schema":"sha256:b0e10849403c45c4a5dc0d94c0c661958cbf7fc9992aad3e48b61d4c7c6fe5a6"}';
const proxyLink = "sha256:d89d353534e817ae9b98919d9dc8f26de27498f6a2fb6301e3a933f73e9b07c2";
const proxySignatureText =
  '{"data":{"identity":"sha256:c7e4b74d0e076b9bde19b3410419f691885b304a4f62f998476a92b691b36938",' +
  '"object":"sha256:d89d353534e817ae9b98919d9dc8f26de27498f6a2fb6301e3a933f73e9b07c2",' +
  '"signature":"f6dbb520c6e394bd1306528e382ab6fd541a808bc9ca5ebdf5fa20dc3421860a' +
  'ca7724d5a27cfb3b43f1968888613b7d5a2d38412d71ff315cd9a72577e6f00e"},' +
  '"schema":"sha256:05b7d8cb16217903e90fbbae01bd0fdf157d10a9829fb22f2729c2e836495506"}';
const proxySignatureLink = "sha256:eb15bf0cf9a174f93b195a7e4c62128df6be34d1a806887c4987b7f88750c2e6";
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
