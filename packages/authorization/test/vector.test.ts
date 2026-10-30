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
  '{"$describedBy":{"$link":"sha256:ce6309cf896e4d74c8e3029ce43c0262508bc3b8926d0a7f38334430cf50cd03"},' +
  '"root":{"$link":"sha256:301a5c2ca31246fe1ae00e0ea57d0a89c8d2b7ec07688792bcd33dd59914db71"}}';
const hotIdentityLink = "sha256:654177cd5e9ca02c1a6469b38fd161b18ad1c5a316d94ab5a09c5cb8015a234e";
const hotSignedText =
  '{"$describedBy":{"$link":"sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa"},' +
  '"identity":{"$link":"sha256:654177cd5e9ca02c1a6469b38fd161b18ad1c5a316d94ab5a09c5cb8015a234e"},' +
  '"signature":"3370e0e132e7d8959dc7f12e2da60f552bfce2c41643b3b30ae9134095ba2d4a' +
  '653ef2b4ec5b0c14a92db94ddd73c762f89be1db804674936954f3fd47f39e08"}';
const hotSignedLink = "sha256:e07fe594686d7757ab1526a10f0ae9ed99ba94f036c4b1e71acf0bc6fa81eb30";
const authorizationText =
  '{"$describedBy":{"$link":"sha256:3eb52fc430c3498d03d3a00452acad920862a45d2e6ec6b525fd28e70968ecff"},' +
  '"agent":{"$link":"sha256:654177cd5e9ca02c1a6469b38fd161b18ad1c5a316d94ab5a09c5cb8015a234e"}}';
const authorizationLink = "sha256:9ef1121be5e063616fda8e06d7c8134abd2d153bf80cab3bec4569b022c18d4a";
const grantText =
  '{"$describedBy":{"$link":"sha256:5b26f24cc52953b3f9ed306e7773dcff9edc5cad8c6a825f02179e3a4a3d7135"},' +
  '"object":{"$link":"sha256:9ef1121be5e063616fda8e06d7c8134abd2d153bf80cab3bec4569b022c18d4a"},' +
  '"signature":"7776606698f43323fcfbce4acdb083cd49eeea0a3de8eee42a8ebd1fb26569ad' +
  '5f6a73da4c76a88123b68b94218c28696740abeafaebdcb6da39e55d0f461708",' +
  '"signedIdentity":{"$link":"sha256:79a3b04b50c3be9620ad9fa529ed3617e6f9a42361b163427c3677d16dc99de9"}}';
const grantLink = "sha256:7d6f948c81cdce1aec4717753aa8061f76df06393ec3fb2afcce0466550c4eae";
const proxyText =
  '{"$describedBy":{"$link":"sha256:ffa6bc8b7be6fa4f12b8be838f62e26eb0e083f1bc50398b422982e0a59dff71"},' +
  '"chain":[{"$link":"sha256:7d6f948c81cdce1aec4717753aa8061f76df06393ec3fb2afcce0466550c4eae"}],' +
  '"target":{"$link":"sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c"}}';
const proxyLink = "sha256:4ced983fce05228e0169736bf792299fcaeb8220959f6b01ca375a7b10cf2acd";
const proxySignatureText =
  '{"$describedBy":{"$link":"sha256:5b26f24cc52953b3f9ed306e7773dcff9edc5cad8c6a825f02179e3a4a3d7135"},' +
  '"object":{"$link":"sha256:4ced983fce05228e0169736bf792299fcaeb8220959f6b01ca375a7b10cf2acd"},' +
  '"signature":"f63a257d9e1b7106d3f6b6783e6fa9c5c1db599d1d0b4bf4b78dea0a86d56d3b' +
  '3ada0fecb9f8d42a95db7b549f61d66abaad0fecc5e84c5dcd836b648c593101",' +
  '"signedIdentity":{"$link":"sha256:e07fe594686d7757ab1526a10f0ae9ed99ba94f036c4b1e71acf0bc6fa81eb30"}}';
const proxySignatureLink = "sha256:dc64df2c483871a16a212e0501ca4b426ac15de63b42663c44fd25e3c5f11bba";
// The signed identity of the signer of the vector in @estoc/identity, its identity and its root.
const rootKeyText =
  '{"$describedBy":{"$link":"sha256:ebbcea47c3c3ce9adc3d76f8450ceba8f413d247a4b2f9b30aca6d2505beb662"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const rootIdentityText =
  '{"$describedBy":{"$link":"sha256:ce6309cf896e4d74c8e3029ce43c0262508bc3b8926d0a7f38334430cf50cd03"},' +
  '"root":{"$link":"sha256:ecc75ffb48855e212f07f6a1bfe71da1e95e47d8f159a0354438ca6fefb90358"}}';
const rootSignedText =
  '{"$describedBy":{"$link":"sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa"},' +
  '"identity":{"$link":"sha256:c36a4b59659e46d1cff6155e12a591a4df054ad7ae95d19148f646bbec482451"},' +
  '"signature":"93d41d81bb53dd53fdde97d6622b66d133021c0beac09de84e9a2d8d28255b1c' +
  '4135912f985b9052fcff77699707827df19be107d5414f456ec1abee307d9706"}';

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
