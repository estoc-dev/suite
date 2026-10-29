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
const hotKeyText =
  '{"$describedBy":{"$link":"sha256:56ba2935043425c303dcf4d2b68ad608ab724b342a8a4c78665829549917912a"},' +
  '"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394"}';
const hotIdentityText =
  '{"$describedBy":{"$link":"sha256:5d77ddabc0855936a22068491f9a0d14ac6a32146334371283edb284a336a526"},' +
  '"root":{"$link":"sha256:77dc4ae3459e1ed1c26f740c469d2f3b4b5a84767185cbef2d52744d68f95df3"}}';
const hotIdentityLink = "sha256:9266b958ad1eca7e1ac843bdc5dde8f3223906f2b85eeeef40b086e6589b2e0a";
const hotSignedText =
  '{"$describedBy":{"$link":"sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa"},' +
  '"identity":{"$link":"sha256:9266b958ad1eca7e1ac843bdc5dde8f3223906f2b85eeeef40b086e6589b2e0a"},' +
  '"signature":"8267a767d773227bc6cb13104b26d6e20467cc4007624512baafa88f402466e0' +
  'b25bbd74a9a4d5c3be59b7fe4db30d5e71ea70ad3859cc32e02cb1685e610b0c"}';
const hotSignedLink = "sha256:2f6bfd6f40544241ba6adbed092f1a84596ea19d83387620f0c5640b657aed72";
const authorizationText =
  '{"$describedBy":{"$link":"sha256:3eb52fc430c3498d03d3a00452acad920862a45d2e6ec6b525fd28e70968ecff"},' +
  '"agent":{"$link":"sha256:9266b958ad1eca7e1ac843bdc5dde8f3223906f2b85eeeef40b086e6589b2e0a"}}';
const authorizationLink = "sha256:29fae116a06b22080608a584f3e4cc7dddd926516303d10ccdfb433f20d43bbc";
const grantText =
  '{"$describedBy":{"$link":"sha256:5b26f24cc52953b3f9ed306e7773dcff9edc5cad8c6a825f02179e3a4a3d7135"},' +
  '"object":{"$link":"sha256:29fae116a06b22080608a584f3e4cc7dddd926516303d10ccdfb433f20d43bbc"},' +
  '"signature":"0457cf39a0a5888e02530342bc8a359752ff1473beffef5790bd9c7fd3d3843d' +
  '8ad66b69c310222287fea2f3dff212f37cea6f1c0ee540ceb41e465331dfc009",' +
  '"signedIdentity":{"$link":"sha256:3499b42ad3b10174ceac2b6d308326e7fb2f0678782c579595d7083a3b3beefe"}}';
const grantLink = "sha256:2a2a69021b3d1c971f5139cdff945139bffa88b557827125b57eb54f03293ed8";
const proxyText =
  '{"$describedBy":{"$link":"sha256:ffa6bc8b7be6fa4f12b8be838f62e26eb0e083f1bc50398b422982e0a59dff71"},' +
  '"chain":[{"$link":"sha256:2a2a69021b3d1c971f5139cdff945139bffa88b557827125b57eb54f03293ed8"}],' +
  '"target":{"$link":"sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c"}}';
const proxyLink = "sha256:ec3ac350c625171e428c7f1fd1697da4623c78fcafd771aa1a88b47ae612c3e0";
const proxySignatureText =
  '{"$describedBy":{"$link":"sha256:5b26f24cc52953b3f9ed306e7773dcff9edc5cad8c6a825f02179e3a4a3d7135"},' +
  '"object":{"$link":"sha256:ec3ac350c625171e428c7f1fd1697da4623c78fcafd771aa1a88b47ae612c3e0"},' +
  '"signature":"541c3ba34accbb745ba04d63c59cf76f9d30638f363390ddc0da4867a44922ea' +
  '5551465505a41c081b21a6856bbdc6c7a14030cb31fe9fd46c4ae5a45fb0a000",' +
  '"signedIdentity":{"$link":"sha256:2f6bfd6f40544241ba6adbed092f1a84596ea19d83387620f0c5640b657aed72"}}';
const proxySignatureLink = "sha256:b94af375d84583e592f9a753241158cee3067016a9f506ccc9132af2d9fdb278";
// The signed identity of the signer of the vector in @estoc/identity, its identity and its root.
const rootKeyText =
  '{"$describedBy":{"$link":"sha256:56ba2935043425c303dcf4d2b68ad608ab724b342a8a4c78665829549917912a"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const rootIdentityText =
  '{"$describedBy":{"$link":"sha256:5d77ddabc0855936a22068491f9a0d14ac6a32146334371283edb284a336a526"},' +
  '"root":{"$link":"sha256:a6394ae7524f9c1ba37d4a86bdc80de04e38d98e0308df12a51a932763e64b22"}}';
const rootSignedText =
  '{"$describedBy":{"$link":"sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa"},' +
  '"identity":{"$link":"sha256:dd31cd36c973940ddcfe6e5a688cf5d33b887b2693d82bae6b9fd359cabda364"},' +
  '"signature":"5cfaf21fdc8c442905a85577e8346727cd635d5042bbe45331b861c3444aef6e' +
  'aa149e6de2bf1543316e69bee4cf66c80056a3f25cb315cc621ae439d8386f01"}';

// The login object of the vector in @estoc/object.
const target: Link<EncodedObject<Json>> = "sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c";
const root = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const hot = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(2));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);

const authorizations = await loadAuthorizations(defaultValidator);
const { signatures } = authorizations;
const { identities } = signatures;
const grant = await authorizations.authorize(hot.key, signatures.actor(root, await identities.publish(root)));
const hotActor = signatures.actor(hot, await identities.publish(hot));
const entry = await authorizations.createActor(hotActor, [grant]).sign(target);
const proxy = entry.blobs.find((blob) => linkOf(blob) === entry.signature.object);
assert.exists(proxy);

describe("the two schemas, an Ed25519 authorization and a proxy its agent signs", () => {
  it("encode to fixed bytes and links", async () => {
    expect((await encodeSchema(authorizationSchema, defaultValidator)).link).toBe(authorizationSchemaLink);
    expect((await encodeSchema(proxySchema, defaultValidator)).link).toBe(proxySchemaLink);
    expect(text(grant.object.agent.root.bytes)).toBe(hotKeyText);
    expect(text(grant.object.agent.bytes)).toBe(hotIdentityText);
    expect(grant.object.agent.link).toBe(hotIdentityLink);
    expect(text(hotActor.signedIdentity.bytes)).toBe(hotSignedText);
    expect(hotActor.signedIdentity.link).toBe(hotSignedLink);
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
    const texts = [
      rootKeyText,
      rootIdentityText,
      rootSignedText,
      hotKeyText,
      hotIdentityText,
      hotSignedText,
      authorizationText,
      grantText,
      proxyText,
      proxySignatureText,
    ];
    const blobs = new Map<string, Uint8Array>(texts.map((text) => [linkOf(utf8(text)), utf8(text)]));
    const read = await authorizations.readAuthorization(grantLink, blobs);
    expect(read.signature.signedIdentity.identity).toEqual(identities.encode(root.key));
    expect(read.object.agent).toEqual(identities.encode(hot.key));
    const standing = await authorizations.readStanding(target, proxySignatureLink, blobs);
    expect(standing).toEqual({
      principal: identities.encode(root.key),
      agents: [identities.encode(hot.key)],
    });
  });
});
