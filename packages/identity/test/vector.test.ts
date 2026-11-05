import { decodeObject, decodeSchema, encodeSchema, type Json, type Link, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it, test } from "vitest";
import {
  delegatedIdentitySchema,
  ed25519,
  eip191,
  identitySchema,
  loadIdentity,
  noVersions,
  type SchemeData,
  SoftwareSigner,
  schemeSchema,
  schemeValidator,
  signatureSchema,
  signedIdentitySchema,
  solanaOffchain,
} from "../src/index.ts";

const { signedIdentities, signatures, publish, delegate } = await loadIdentity(defaultValidator);
const keyScheme: Schema<Json, SchemeData> = await encodeSchema(schemeSchema, defaultValidator);
const schemeObjects = schemeValidator(keyScheme);

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and against
// its hashlib; the signatures, which Ed25519 makes deterministic, against
// Python's cryptography package. A change to the format changes them.
const schemeSchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"name":{"type":"string"},"publicKeyLength":{"minimum":1,"type":"integer"}},' +
  '"required":["name","publicKeyLength"],"title":"Key Scheme","type":"object"}}';
const schemeSchemaLink = "sha256:14916fbf1e5472070cfde6c14cfdde45186db7ec6cc19d91f12bcad38e1357f4";
const ed25519SchemeText =
  '{"$schema":{"$link":"sha256:14916fbf1e5472070cfde6c14cfdde45186db7ec6cc19d91f12bcad38e1357f4"},' +
  '"name":"ed25519","publicKeyLength":32}';
const schemes = [
  {
    scheme: ed25519,
    text: ed25519SchemeText,
    link: "sha256:57236c4b4d4885a804a04068e9a8c5b0a5a25cf27b8b248c7671d1495b3f0528",
  },
  {
    scheme: eip191,
    text:
      '{"$schema":{"$link":"sha256:14916fbf1e5472070cfde6c14cfdde45186db7ec6cc19d91f12bcad38e1357f4"},' +
      '"name":"eip191","publicKeyLength":33}',
    link: "sha256:06ab36aaf177ae229c46545d5240b3ff1ad94268eed6d1547eacc57f7b89428f",
  },
  {
    scheme: solanaOffchain,
    text:
      '{"$schema":{"$link":"sha256:14916fbf1e5472070cfde6c14cfdde45186db7ec6cc19d91f12bcad38e1357f4"},' +
      '"name":"solana-offchain","publicKeyLength":32}',
    link: "sha256:d6d8af532285e95b93796c26b0273bfceee7223932864543287f734e8f078d1d",
  },
];
const identitySchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"at":{"minimum":0,"type":"integer"},' +
  '"root":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},"required":["root","at"],' +
  '"title":"Identity","type":"object"}}';
const identitySchemaLink = "sha256:f9fcc71f3625929ed2d27067970e7d6cb38db30dd3d4d1c41d81be5b046f5ab7";
const delegatedIdentitySchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"agents":{"items":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$",' +
  '"type":"string"},"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"maxItems":256,"type":"array","uniqueItems":true},"at":{"minimum":0,"type":"integer"},' +
  '"root":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},"required":["root",' +
  '"agents","at"],"title":"Delegated Identity","type":"object"}}';
const delegatedIdentitySchemaLink = "sha256:33d1ce92ec18cd317921c69fe5b56881e28d95c69ff276f9f42c6e374ace8c9d";
const keyText =
  '{"$schema":{"$link":"sha256:57236c4b4d4885a804a04068e9a8c5b0a5a25cf27b8b248c7671d1495b3f0528"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const keyLink = "sha256:cfb93cd8b7d44611bdc136c3d6bb98c5204fa8e90d78d7fcc2233892b34405a9";
const identityText =
  '{"$schema":{"$link":"sha256:f9fcc71f3625929ed2d27067970e7d6cb38db30dd3d4d1c41d81be5b046f5ab7"},' +
  '"at":1767225600000,' +
  '"root":{"$link":"sha256:cfb93cd8b7d44611bdc136c3d6bb98c5204fa8e90d78d7fcc2233892b34405a9"}}';
const identityLink = "sha256:4f82dee355134c70145e97849da3f99017abac0240a21eb522e88a8329a8495b";
const signedIdentitySchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"identity":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$",' +
  '"type":"string"},"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"}},"required":["identity","signature"],' +
  '"title":"Signed Identity","type":"object"}}';
const signedIdentitySchemaLink = "sha256:6ff4089d10d54822ae943cd0d5d6c2122382d269c79e59306c2ea7a3c1db8ec2";
const signedIdentityText =
  '{"$schema":{"$link":"sha256:6ff4089d10d54822ae943cd0d5d6c2122382d269c79e59306c2ea7a3c1db8ec2"},' +
  '"identity":{"$link":"sha256:4f82dee355134c70145e97849da3f99017abac0240a21eb522e88a8329a8495b"},' +
  '"signature":"93b5b886255a444aa89df3676e028e36c25f0f6d065e69ca83f66746c482af8bd3fcd7a9952afd7257b720a' +
  'ff4733761c142ad0d12307c808b71efce3e022a01"}';
const signedIdentityLink = "sha256:594e6783ce52b6d891186b15aed00844b84468b458ccba166dd15d77f537eadf";
const signatureSchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"object":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"},' +
  '"signedIdentity":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},' +
  '"required":["signedIdentity","object","signature"],"title":"Signature","type":"object"}}';
const signatureSchemaLink = "sha256:7090ce0b5950e2d59e4af998b51090059cff783b8f05b4c12817acbe36c573c4";
const signatureText =
  '{"$schema":{"$link":"sha256:7090ce0b5950e2d59e4af998b51090059cff783b8f05b4c12817acbe36c573c4"},' +
  '"object":{"$link":"sha256:7f0842ff8211ee8330f12285571af67d615bb76dbedaec6eb9b5ae9686fa2df4"},' +
  '"signature":"92af1ae34cf530cfc3f433ba227b42d69835955df17f3cb1174177b7078bd6beb7dcdc47c71dab2b342c0a2' +
  'c1b7924da6b49ac8cfecbcdec3b31c2a4a14d1c09",' +
  '"signedIdentity":{"$link":"sha256:594e6783ce52b6d891186b15aed00844b84468b458ccba166dd15d77f537eadf"}' +
  "}";
const signatureLink = "sha256:24f33da59eee939ccaaafb3c5ed731ebad91acc0bb6b9b9600c8b82db219cb2b";
const agentKeyTexts = [
  '{"$schema":{"$link":"sha256:57236c4b4d4885a804a04068e9a8c5b0a5a25cf27b8b248c7671d1495b3f0528"},' +
    '"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394"}',
  '{"$schema":{"$link":"sha256:57236c4b4d4885a804a04068e9a8c5b0a5a25cf27b8b248c7671d1495b3f0528"},' +
    '"publicKey":"ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1"}',
] as const;
const agentKeyLinks = [
  "sha256:eec1b978328fc012fd87c8ac60da9122d3ef5c33fe2c33c6dd2063e11d4be439",
  "sha256:857b0c10eeab7719dcf3daabf93e917cd0148261727d6c8b94c6e7bc1468a79b",
] as const;
const delegatedIdentityText =
  '{"$schema":{"$link":"sha256:33d1ce92ec18cd317921c69fe5b56881e28d95c69ff276f9f42c6e374ace8c9d"},' +
  '"agents":[{"$link":"sha256:eec1b978328fc012fd87c8ac60da9122d3ef5c33fe2c33c6dd2063e11d4be439"},' +
  '{"$link":"sha256:857b0c10eeab7719dcf3daabf93e917cd0148261727d6c8b94c6e7bc1468a79b"}],' +
  '"at":1767225600000,' +
  '"root":{"$link":"sha256:cfb93cd8b7d44611bdc136c3d6bb98c5204fa8e90d78d7fcc2233892b34405a9"}}';
const delegatedIdentityLink = "sha256:fecb1ce17586307afc3a1c54dbd36d1c42f6fc055c5755e89f78db056714c5e6";
const delegatedSignedIdentityText =
  '{"$schema":{"$link":"sha256:6ff4089d10d54822ae943cd0d5d6c2122382d269c79e59306c2ea7a3c1db8ec2"},' +
  '"identity":{"$link":"sha256:fecb1ce17586307afc3a1c54dbd36d1c42f6fc055c5755e89f78db056714c5e6"},' +
  '"signature":"c712ea1de581c58d8436aedb9e8073893c6bc000d10cc4bd6d141cd01acb0eb97a6d6591dca5db3664d65ba' +
  '9d3547c70227c140bbce8ae21c4c3ce879b032d02"}';
const delegatedSignedIdentityLink = "sha256:4f52127c156c09f044e7cae5cd28eeea5292fbc8ecad178af1c31d53e69db02d";
const delegatedSignatureText =
  '{"$schema":{"$link":"sha256:7090ce0b5950e2d59e4af998b51090059cff783b8f05b4c12817acbe36c573c4"},' +
  '"object":{"$link":"sha256:7f0842ff8211ee8330f12285571af67d615bb76dbedaec6eb9b5ae9686fa2df4"},' +
  '"signature":"01e8b8da322ed66d0b957dea08818df5a67e617c062783b66e61778121834275b1369af2b1afba7ac08575c' +
  'cc412e98619cc29a316812d5441a7873e676b61330e",' +
  '"signedIdentity":{"$link":"sha256:4f52127c156c09f044e7cae5cd28eeea5292fbc8ecad178af1c31d53e69db02d"}' +
  "}";
const delegatedSignatureLink = "sha256:3f7bb1c141288e266f9ae2eec6d15e28f5ba53bf41e5ffe5a3e4db31452741f3";

// The login object of the vector in @estoc/object.
const objectLink: Link<never> = "sha256:7f0842ff8211ee8330f12285571af67d615bb76dbedaec6eb9b5ae9686fa2df4";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);

test("the scheme schema encodes to fixed bytes and a fixed link", () => {
  expect(text(keyScheme.bytes)).toBe(schemeSchemaText);
  expect(keyScheme.link).toBe(schemeSchemaLink);
});

test.each(schemes)(
  "the object of $scheme.name encodes to fixed bytes and a fixed link",
  async ({ scheme, text: expected, link }) => {
    const data = { name: scheme.name, publicKeyLength: scheme.curve.publicKeyLength };
    const schema = await encodeSchema(data, schemeObjects);
    expect(text(schema.bytes)).toBe(expected);
    expect(schema.link).toBe(link);
    expect((await decodeSchema(utf8(expected), schemeObjects)).link).toBe(link);
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

describe("an Identity with an Ed25519 root at the start of 2026, signed, and its signature over the login object of @estoc/object", () => {
  it("encode to fixed bytes and links", async () => {
    const root = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
    const actor = signatures.actor(root, await publish(root, Date.parse("2026-01-01T00:00:00Z")));
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
    const read = await signedIdentities.read(signedIdentityLink, blobs);
    expect(read.identity.link).toBe(identityLink);
    expect(read.identity.root.scheme).toBe(ed25519);
    const keySchema = await decodeSchema(utf8(ed25519SchemeText), schemeObjects);
    expect(decodeObject(utf8(keyText), keySchema).link).toBe(keyLink);
    const schema = await decodeSchema(utf8(identitySchemaText), defaultValidator);
    expect(decodeObject(utf8(identityText), schema).link).toBe(identityLink);
    const signedSchema = await decodeSchema(utf8(signedIdentitySchemaText), defaultValidator);
    expect(decodeObject(utf8(signedIdentityText), signedSchema).link).toBe(signedIdentityLink);
    const signature = decodeObject(utf8(signatureText), signatures.schema);
    expect((await signatures.verify(signature, blobs, noVersions)).link).toBe(signatureLink);
  });
});

describe("a Delegated Identity with that root and two Ed25519 agents at the start of 2026, signed, and the second agent's signature over the login object", () => {
  const signer = (fill: number) => SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(fill));
  const agents = [signer(2), signer(3)] as const;
  const at = Date.parse("2026-01-01T00:00:00Z");

  it("encode to fixed bytes and links", async () => {
    const signedIdentity = await delegate(signer(1), [agents[0].key, agents[1].key], at);
    const signature = await signatures.actor(agents[1], signedIdentity).sign({ link: objectLink });
    const { identity } = signedIdentity;
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
    const signature = await signatures.verify(
      decodeObject(utf8(delegatedSignatureText), signatures.schema),
      blobs,
      noVersions,
    );
    expect(signature.link).toBe(delegatedSignatureLink);
    expect(signature.key.link).toBe(agentKeyLinks[1]);
  });
});
