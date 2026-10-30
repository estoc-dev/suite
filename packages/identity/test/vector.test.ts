import { decodeObject, decodeSchema, encodeSchema, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it, test } from "vitest";
import {
  type DelegatedIdentityObject,
  delegatedIdentitySchema,
  identityInterface,
  identitySchema,
  keyInterface,
  keySchemas,
  loadSignatures,
  type Scheme,
  SoftwareSigner,
  signatureSchema,
  signedIdentitySchema,
} from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and against
// its hashlib; the signatures, which Ed25519 makes deterministic, against
// Python's cryptography package. A change to the format changes them.
const keyInterfaceLink = "sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160";
const identityInterfaceLink = "sha256:999f23fcd7bec7075e54bb5dea0d9c548bfe7261f95b911ed8e23d2f4188724f";
const keySchemaTexts: Record<Scheme, string> = {
  ed25519:
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    '"properties":{"publicKey":{"pattern":"^[0-9a-f]{64}$","type":"string"}},' +
    '"required":["publicKey"],"title":"Ed25519 key","type":"object",' +
    '"x-implements":{"$link":"sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160"}}',
  eip191:
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    '"properties":{"publicKey":{"pattern":"^[0-9a-f]{66}$","type":"string"}},' +
    '"required":["publicKey"],"title":"EIP-191 key","type":"object",' +
    '"x-implements":{"$link":"sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160"}}',
  "solana-offchain":
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    '"properties":{"publicKey":{"pattern":"^[0-9a-f]{64}$","type":"string"}},' +
    '"required":["publicKey"],"title":"Solana off-chain key","type":"object",' +
    '"x-implements":{"$link":"sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160"}}',
};
const keySchemaLinks: Record<Scheme, string> = {
  ed25519: "sha256:ebbcea47c3c3ce9adc3d76f8450ceba8f413d247a4b2f9b30aca6d2505beb662",
  eip191: "sha256:8896cefe124af9a93c39ced7f4190a39a5573928806c256e5af54323a1b38d1a",
  "solana-offchain": "sha256:c0bee18e26838f2864b6e7864e3a81ab41cc9d95a65c47c3d5ae491522236822",
};
const identitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"root":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},' +
  '"required":["root"],"title":"Identity","type":"object",' +
  '"x-implements":{"$link":"sha256:999f23fcd7bec7075e54bb5dea0d9c548bfe7261f95b911ed8e23d2f4188724f"}}';
const identitySchemaLink = "sha256:ce6309cf896e4d74c8e3029ce43c0262508bc3b8926d0a7f38334430cf50cd03";
const delegatedIdentitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"agents":{"items":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"maxItems":256,"type":"array","uniqueItems":true},' +
  '"root":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},' +
  '"required":["root","agents"],"title":"Delegated Identity","type":"object",' +
  '"x-implements":{"$link":"sha256:999f23fcd7bec7075e54bb5dea0d9c548bfe7261f95b911ed8e23d2f4188724f"}}';
const delegatedIdentitySchemaLink = "sha256:9d8b1d1592399f12dc1d6130f3926c8ac875c096bc6032f31a04159897560ffb";
const keyText =
  '{"$describedBy":{"$link":"sha256:ebbcea47c3c3ce9adc3d76f8450ceba8f413d247a4b2f9b30aca6d2505beb662"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const keyLink = "sha256:ecc75ffb48855e212f07f6a1bfe71da1e95e47d8f159a0354438ca6fefb90358";
const identityText =
  '{"$describedBy":{"$link":"sha256:ce6309cf896e4d74c8e3029ce43c0262508bc3b8926d0a7f38334430cf50cd03"},' +
  '"root":{"$link":"sha256:ecc75ffb48855e212f07f6a1bfe71da1e95e47d8f159a0354438ca6fefb90358"}}';
const identityLink = "sha256:c36a4b59659e46d1cff6155e12a591a4df054ad7ae95d19148f646bbec482451";
const signedIdentitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"identity":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"}},' +
  '"required":["identity","signature"],"title":"Signed Identity","type":"object"}';
const signedIdentitySchemaLink = "sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa";
const signedIdentityText =
  '{"$describedBy":{"$link":"sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa"},' +
  '"identity":{"$link":"sha256:c36a4b59659e46d1cff6155e12a591a4df054ad7ae95d19148f646bbec482451"},' +
  '"signature":"93d41d81bb53dd53fdde97d6622b66d133021c0beac09de84e9a2d8d28255b1c' +
  '4135912f985b9052fcff77699707827df19be107d5414f456ec1abee307d9706"}';
const signedIdentityLink = "sha256:79a3b04b50c3be9620ad9fa529ed3617e6f9a42361b163427c3677d16dc99de9";
const signatureSchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"object":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"},' +
  '"signedIdentity":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},' +
  '"required":["signedIdentity","object","signature"],"title":"Signature","type":"object"}';
const signatureSchemaLink = "sha256:5b26f24cc52953b3f9ed306e7773dcff9edc5cad8c6a825f02179e3a4a3d7135";
const signatureText =
  '{"$describedBy":{"$link":"sha256:5b26f24cc52953b3f9ed306e7773dcff9edc5cad8c6a825f02179e3a4a3d7135"},' +
  '"object":{"$link":"sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c"},' +
  '"signature":"97f0f7ab4636f3da004d99e4983804bc5dcb2bab0fa8dea3d0acb69db31f4210' +
  'c8d0ee29bde6488ed8212ca9eb57c639d2c20d80a5abd12dd1dc169d8b80e30b",' +
  '"signedIdentity":{"$link":"sha256:79a3b04b50c3be9620ad9fa529ed3617e6f9a42361b163427c3677d16dc99de9"}}';
const signatureLink = "sha256:c3d1503c07db59ebe73138fa9ef10a4f4f71486456b02fa15dda7a2bddc427a0";
const agentKeyTexts = [
  '{"$describedBy":{"$link":"sha256:ebbcea47c3c3ce9adc3d76f8450ceba8f413d247a4b2f9b30aca6d2505beb662"},' +
    '"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394"}',
  '{"$describedBy":{"$link":"sha256:ebbcea47c3c3ce9adc3d76f8450ceba8f413d247a4b2f9b30aca6d2505beb662"},' +
    '"publicKey":"ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1"}',
] as const;
const agentKeyLinks = [
  "sha256:301a5c2ca31246fe1ae00e0ea57d0a89c8d2b7ec07688792bcd33dd59914db71",
  "sha256:a883261c6730f312d9edae37efbbbb5a247fde743001b6677501a8c064f564b5",
] as const;
const delegatedIdentityText =
  '{"$describedBy":{"$link":"sha256:9d8b1d1592399f12dc1d6130f3926c8ac875c096bc6032f31a04159897560ffb"},' +
  '"agents":[{"$link":"sha256:301a5c2ca31246fe1ae00e0ea57d0a89c8d2b7ec07688792bcd33dd59914db71"},' +
  '{"$link":"sha256:a883261c6730f312d9edae37efbbbb5a247fde743001b6677501a8c064f564b5"}],' +
  '"root":{"$link":"sha256:ecc75ffb48855e212f07f6a1bfe71da1e95e47d8f159a0354438ca6fefb90358"}}';
const delegatedIdentityLink = "sha256:5b27ac1d213fd9604c578d69fde4d2981ae18a099d41c50f61ab2a8024ebeb99";
const delegatedSignedIdentityText =
  '{"$describedBy":{"$link":"sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa"},' +
  '"identity":{"$link":"sha256:5b27ac1d213fd9604c578d69fde4d2981ae18a099d41c50f61ab2a8024ebeb99"},' +
  '"signature":"690f1a13795f722b2bae189603391462fe924a506f86f047a7b21bf5fa73cd18' +
  'bba5f8274e64f9073a99c32164c4922755752bfca15f4ac0b6b7c9131c40c901"}';
const delegatedSignedIdentityLink = "sha256:9421e6050b2383e182455934fee9198614ab54a2e54fcd43eafeed57d125c978";
const delegatedSignatureText =
  '{"$describedBy":{"$link":"sha256:5b26f24cc52953b3f9ed306e7773dcff9edc5cad8c6a825f02179e3a4a3d7135"},' +
  '"object":{"$link":"sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c"},' +
  '"signature":"01' +
  "3f9e1556e55f17dd45fb09e0b6888a15c3c5498543f5ccc9e09dea90d33b81cf" +
  'a486b924eaae89b4d09664e56492c9b317616e7d8edabeea28d6484b24d8830c",' +
  '"signedIdentity":{"$link":"sha256:9421e6050b2383e182455934fee9198614ab54a2e54fcd43eafeed57d125c978"}}';
const delegatedSignatureLink = "sha256:de6f133e7f76feb55e9311dd70fc0e81c0298e6162e76780e37ae33c99414abb";

// The login object of the vector in @estoc/object.
const objectLink: Link<never> = "sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);

test.each([
  ["Key", keyInterface, keyInterfaceLink],
  ["Identity", identityInterface, identityInterfaceLink],
] as const)("the %s interface is its name in UTF-8, with a fixed link", (name, { bytes, link }, expected) => {
  expect(text(bytes)).toBe(name);
  expect(link).toBe(expected);
});

test.each(["ed25519", "eip191", "solana-offchain"] as const)(
  "the key schema of %s encodes to fixed bytes and a fixed link",
  async (scheme) => {
    const schema = await encodeSchema(keySchemas[scheme], defaultValidator);
    expect(text(schema.bytes)).toBe(keySchemaTexts[scheme]);
    expect(schema.link).toBe(keySchemaLinks[scheme]);
  },
);

test.each([
  ["Identity", identitySchema, identitySchemaText, identitySchemaLink],
  ["Delegated Identity", delegatedIdentitySchema, delegatedIdentitySchemaText, delegatedIdentitySchemaLink],
])("the %s schema encodes to fixed bytes and a fixed link", async (_, json, bytes, link) => {
  const schema = await encodeSchema(json, defaultValidator);
  expect(text(schema.bytes)).toBe(bytes);
  expect(schema.link).toBe(link);
});

test("the signed identity schema encodes to fixed bytes and a fixed link", async () => {
  const schema = await encodeSchema(signedIdentitySchema, defaultValidator);
  expect(text(schema.bytes)).toBe(signedIdentitySchemaText);
  expect(schema.link).toBe(signedIdentitySchemaLink);
});

test("the signature schema encodes to fixed bytes and a fixed link", async () => {
  const schema = await encodeSchema(signatureSchema, defaultValidator);
  expect(text(schema.bytes)).toBe(signatureSchemaText);
  expect(schema.link).toBe(signatureSchemaLink);
});

describe("an Identity with an Ed25519 root, signed, and its signature over the login object of @estoc/object", () => {
  it("encode to fixed bytes and links", async () => {
    const root = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
    const actor = signatures.actor(root, await signatures.identities.publish(root));
    const signature = await actor.sign({ link: objectLink });
    const { identity } = signature.signedIdentity;
    expect(text(identity.root.bytes)).toBe(keyText);
    expect(identity.root.link).toBe(keyLink);
    expect(text(identity.bytes)).toBe(identityText);
    expect(identity.link).toBe(identityLink);
    expect(text(signature.signedIdentity.bytes)).toBe(signedIdentityText);
    expect(signature.signedIdentity.link).toBe(signedIdentityLink);
    expect(text(signature.bytes)).toBe(signatureText);
    expect(signature.link).toBe(signatureLink);
  });

  it("decode from those bytes", async () => {
    const blobs = new Map([
      [keyLink, utf8(keyText)],
      [identityLink, utf8(identityText)],
      [signedIdentityLink, utf8(signedIdentityText)],
    ]);
    const read = await signatures.identities.read(signedIdentityLink, blobs);
    expect(read.identity.link).toBe(identityLink);
    expect(read.identity.root.scheme).toBe("ed25519");
    const keySchema = await decodeSchema(utf8(keySchemaTexts.ed25519), defaultValidator);
    expect(decodeObject(utf8(keyText), keySchema).link).toBe(keyLink);
    const schema = await decodeSchema(utf8(identitySchemaText), defaultValidator);
    expect(decodeObject(utf8(identityText), schema).link).toBe(identityLink);
    const signedSchema = await decodeSchema(utf8(signedIdentitySchemaText), defaultValidator);
    expect(decodeObject(utf8(signedIdentityText), signedSchema).link).toBe(signedIdentityLink);
    const signature = decodeObject(utf8(signatureText), signatures.schema);
    expect((await signatures.verify(signature, blobs)).link).toBe(signatureLink);
  });
});

describe("a Delegated Identity with that root and two Ed25519 agents, signed, and the second agent's signature over the login object", () => {
  const signer = (fill: number) => SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(fill));
  const agents = [signer(2), signer(3)] as const;

  it("encode to fixed bytes and links", async () => {
    const signedIdentity = await signatures.identities.delegate(signer(1), [agents[0].key, agents[1].key]);
    const signature = await signatures.actor(agents[1], signedIdentity).sign({ link: objectLink });
    const identity = signedIdentity.identity as DelegatedIdentityObject;
    expect(identity.agents.map(({ bytes }) => text(bytes))).toEqual(agentKeyTexts);
    expect(identity.agents.map(({ link }) => link)).toEqual(agentKeyLinks);
    expect(text(identity.bytes)).toBe(delegatedIdentityText);
    expect(identity.link).toBe(delegatedIdentityLink);
    expect(text(signedIdentity.bytes)).toBe(delegatedSignedIdentityText);
    expect(signedIdentity.link).toBe(delegatedSignedIdentityLink);
    expect(text(signature.bytes)).toBe(delegatedSignatureText);
    expect(signature.link).toBe(delegatedSignatureLink);
  });

  it("decode from those bytes, with the second agent as the signature's key", async () => {
    const blobs = new Map([
      [keyLink, utf8(keyText)],
      [agentKeyLinks[0], utf8(agentKeyTexts[0])],
      [agentKeyLinks[1], utf8(agentKeyTexts[1])],
      [delegatedIdentityLink, utf8(delegatedIdentityText)],
      [delegatedSignedIdentityLink, utf8(delegatedSignedIdentityText)],
    ]);
    const schema = await decodeSchema(utf8(delegatedIdentitySchemaText), defaultValidator);
    expect(decodeObject(utf8(delegatedIdentityText), schema).link).toBe(delegatedIdentityLink);
    const signature = await signatures.verify(decodeObject(utf8(delegatedSignatureText), signatures.schema), blobs);
    expect(signature.link).toBe(delegatedSignatureLink);
    expect(signature.key.link).toBe(agentKeyLinks[1]);
  });
});
