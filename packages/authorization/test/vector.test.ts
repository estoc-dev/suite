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
  '{"$describedBy":{"$link":"sha256:c8a75f0349805a6afaa44d44ea0787c048310934de9dc8565788f0f003014be5"},' +
  '"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394"}';
const hotIdentityLink = "sha256:a5d60d006cb3713cabb1e17e0a4633a8fc68e55f220d7a09df1451263f1d8ed3";
const authorizationText =
  '{"$describedBy":{"$link":"sha256:3eb52fc430c3498d03d3a00452acad920862a45d2e6ec6b525fd28e70968ecff"},' +
  '"agent":{"$link":"sha256:a5d60d006cb3713cabb1e17e0a4633a8fc68e55f220d7a09df1451263f1d8ed3"}}';
const authorizationLink = "sha256:2463c1d7a92203e65373f266289041a5f82486ccf010acfc56729fc870351a59";
const grantText =
  '{"$describedBy":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"},' +
  '"identity":{"$link":"sha256:85ec27528b097c6c4b3f41dff76f54c3fe33fc47a7e50fb16878a994d8558065"},' +
  '"object":{"$link":"sha256:2463c1d7a92203e65373f266289041a5f82486ccf010acfc56729fc870351a59"},' +
  '"signature":"74e065ef21c869ae623d9a79518f8843f93ad286ace42c98eeb815c1548bff25' +
  '9089b87be764b527a81ea7b1a04de9a88bc20f0b7859f9e702d8da45f8c98005"}';
const grantLink = "sha256:b38adf42f0f4a667ba98c7d85e291fb0f039b3fe19184db727ad7c669aa92c5c";
const proxyText =
  '{"$describedBy":{"$link":"sha256:ffa6bc8b7be6fa4f12b8be838f62e26eb0e083f1bc50398b422982e0a59dff71"},' +
  '"chain":[{"$link":"sha256:b38adf42f0f4a667ba98c7d85e291fb0f039b3fe19184db727ad7c669aa92c5c"}],' +
  '"target":{"$link":"sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c"}}';
const proxyLink = "sha256:aeefea4eb7abee22ce0d28a00a25fff27922e709805bc83a2ccec4110f473f85";
const proxySignatureText =
  '{"$describedBy":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"},' +
  '"identity":{"$link":"sha256:a5d60d006cb3713cabb1e17e0a4633a8fc68e55f220d7a09df1451263f1d8ed3"},' +
  '"object":{"$link":"sha256:aeefea4eb7abee22ce0d28a00a25fff27922e709805bc83a2ccec4110f473f85"},' +
  '"signature":"ec750eb08b77d24a8567b12f7100300fb002cb311d7114f07beb7a0188163fe8' +
  'b75f8402ce211a805fb59d0a0d702dde9c0489edba0f6f18845364135394700b"}';
const proxySignatureLink = "sha256:48b9d3b6ef26955dc3801c5afee49e7cc94bd98257c08b5ef8fb00926f71f231";
// The identity object of the signer of the vector in @estoc/identity.
const rootIdentityText =
  '{"$describedBy":{"$link":"sha256:c8a75f0349805a6afaa44d44ea0787c048310934de9dc8565788f0f003014be5"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';

// The login object of the vector in @estoc/object.
const target: Link<EncodedObject<Json>> = "sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c";
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
