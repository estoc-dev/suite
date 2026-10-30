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
  '{"$describedBy":{"$link":"sha256:ebbcea47c3c3ce9adc3d76f8450ceba8f413d247a4b2f9b30aca6d2505beb662"},' +
  '"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394"}';
const hotIdentityText =
  '{"$describedBy":{"$link":"sha256:bffc12f8ae0d1515e678ceca43c4d2a1b05ce53ee822500fd30c868d0210f362"},' +
  '"root":{"$link":"sha256:301a5c2ca31246fe1ae00e0ea57d0a89c8d2b7ec07688792bcd33dd59914db71"}}';
const hotIdentityLink = "sha256:7e28ce92ec55082f487b519bd1b9ae4cd6c7aef1fa247281beca27aed37ae448";
const hotSignedText =
  '{"$describedBy":{"$link":"sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa"},' +
  '"identity":{"$link":"sha256:7e28ce92ec55082f487b519bd1b9ae4cd6c7aef1fa247281beca27aed37ae448"},' +
  '"signature":"01b4738026d58089c87b2d1deb020c5ad35556c537b2312fc641e54871f84f58' +
  '1122cfedafdc840203cbf0a0e47967216a19c8321b3fb399d85156638ebe1b03"}';
const hotSignedLink = "sha256:42f5cef98212e3873497c1afb8d2cfa02bfc52e8c29f9239b9e85ac8385ba00c";
const authorizationText =
  '{"$describedBy":{"$link":"sha256:3eb52fc430c3498d03d3a00452acad920862a45d2e6ec6b525fd28e70968ecff"},' +
  '"agent":{"$link":"sha256:7e28ce92ec55082f487b519bd1b9ae4cd6c7aef1fa247281beca27aed37ae448"}}';
const authorizationLink = "sha256:2164a626a1426b776b32b2599b379e1bc966235ecadc06f53cc5d1ab611b3095";
const grantText =
  '{"$describedBy":{"$link":"sha256:5b26f24cc52953b3f9ed306e7773dcff9edc5cad8c6a825f02179e3a4a3d7135"},' +
  '"object":{"$link":"sha256:2164a626a1426b776b32b2599b379e1bc966235ecadc06f53cc5d1ab611b3095"},' +
  '"signature":"fcd0f317d6602ddc679046a0f993438fbf8c38527315240af15799f093bcfea3' +
  '954944dc53f3ac682ed0abca2576d3668ff5063e2785f0c5b816fa756767b70c",' +
  '"signedIdentity":{"$link":"sha256:85dd9e2207b1a986cde3784d467879bd7d9ce952d70c37acce9dce617a4576d2"}}';
const grantLink = "sha256:06036726c5da172a4685fe6f628b862d3491d579ec25b6db6f3f7c0767cd8996";
const proxyText =
  '{"$describedBy":{"$link":"sha256:ffa6bc8b7be6fa4f12b8be838f62e26eb0e083f1bc50398b422982e0a59dff71"},' +
  '"chain":[{"$link":"sha256:06036726c5da172a4685fe6f628b862d3491d579ec25b6db6f3f7c0767cd8996"}],' +
  '"target":{"$link":"sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c"}}';
const proxyLink = "sha256:c0f9074663af094ba21d96d3184e5322c45fcfcc5441f91304794dc83c455757";
const proxySignatureText =
  '{"$describedBy":{"$link":"sha256:5b26f24cc52953b3f9ed306e7773dcff9edc5cad8c6a825f02179e3a4a3d7135"},' +
  '"object":{"$link":"sha256:c0f9074663af094ba21d96d3184e5322c45fcfcc5441f91304794dc83c455757"},' +
  '"signature":"73917e6e57110f8ef7e6e765ec1dcd62fbb0af5cebb0e875e8642e05619272ad' +
  '337bf817084c7e1c273d953e51adc4c598259f0d3c1f7842974adbf273611200",' +
  '"signedIdentity":{"$link":"sha256:42f5cef98212e3873497c1afb8d2cfa02bfc52e8c29f9239b9e85ac8385ba00c"}}';
const proxySignatureLink = "sha256:0abd0e6cda74e9e8fef802ec172e8582bd633c223c6b5507fa36ab3881d56565";
// The signed identity of the signer of the vector in @estoc/identity, its identity and its root.
const rootKeyText =
  '{"$describedBy":{"$link":"sha256:ebbcea47c3c3ce9adc3d76f8450ceba8f413d247a4b2f9b30aca6d2505beb662"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const rootIdentityText =
  '{"$describedBy":{"$link":"sha256:bffc12f8ae0d1515e678ceca43c4d2a1b05ce53ee822500fd30c868d0210f362"},' +
  '"root":{"$link":"sha256:ecc75ffb48855e212f07f6a1bfe71da1e95e47d8f159a0354438ca6fefb90358"}}';
const rootSignedText =
  '{"$describedBy":{"$link":"sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa"},' +
  '"identity":{"$link":"sha256:e36a63b250c8e05258d06aa68b0b1ead71b255ad08a96f426c9ee52ef6e34b99"},' +
  '"signature":"879c083c555339acf377ad210b00c9ea74740e6f197e696baf5f128506eb0927' +
  '4276759c728e131a40270acd15491537fa50f0818301b49c4759f3ba72514c03"}';

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
