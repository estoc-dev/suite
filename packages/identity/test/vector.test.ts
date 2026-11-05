import { decodeObject, decodeSchema, encodeSchema, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it, test } from "vitest";
import {
  delegatedIdentitySchema,
  ed25519,
  eip191,
  identityInterface,
  identitySchema,
  keyInterface,
  loadIdentity,
  noVersions,
  SoftwareSigner,
  signatureSchema,
  signedIdentitySchema,
  solanaOffchain,
} from "../src/index.ts";

const { signedIdentities, signatures, publish, delegate } = await loadIdentity(defaultValidator);

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and against
// its hashlib; the signatures, which Ed25519 makes deterministic, against
// Python's cryptography package. A change to the format changes them.
const keyInterfaceLink = "sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160";
const identityInterfaceLink = "sha256:999f23fcd7bec7075e54bb5dea0d9c548bfe7261f95b911ed8e23d2f4188724f";
const ed25519KeySchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"publicKey":{"pattern":"^[0-9a-f]{64}$","type":"string"}},"required":["publicKey"],' +
  '"title":"Ed25519 key","type":"object",' +
  '"x-implements":{"$link":"sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160"}}}';
const keySchemas = [
  {
    scheme: ed25519,
    text: ed25519KeySchemaText,
    link: "sha256:806f6c529a168ad41bc7deee10a1c67027f2332648fa29a7a5f33bff9d83f19d",
  },
  {
    scheme: eip191,
    text:
      '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
      '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
      '"properties":{"publicKey":{"pattern":"^[0-9a-f]{66}$","type":"string"}},"required":["publicKey"],' +
      '"title":"EIP-191 key","type":"object",' +
      '"x-implements":{"$link":"sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160"}}}',
    link: "sha256:190f56b1528699ccc2194d0a3a3cbc8f9718010c59f89b727d3b8d3f9a188f70",
  },
  {
    scheme: solanaOffchain,
    text:
      '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
      '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
      '"properties":{"publicKey":{"pattern":"^[0-9a-f]{64}$","type":"string"}},"required":["publicKey"],' +
      '"title":"Solana off-chain key","type":"object",' +
      '"x-implements":{"$link":"sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160"}}}',
    link: "sha256:326d9922d773eddf9e565c065b729f51e7a1f64e876f8dd5633eea5cb2080a14",
  },
];
const identitySchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"at":{"minimum":0,"type":"integer"},' +
  '"root":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},"required":["root","at"],' +
  '"title":"Identity","type":"object",' +
  '"x-implements":{"$link":"sha256:999f23fcd7bec7075e54bb5dea0d9c548bfe7261f95b911ed8e23d2f4188724f"}}}';
const identitySchemaLink = "sha256:22ad1b36ad3b46ada728ea6d6df738a1f306bf6917cef82d7c7a951709e1b422";
const delegatedIdentitySchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"agents":{"items":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$",' +
  '"type":"string"},"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},"maxItems":256,' +
  '"type":"array","uniqueItems":true},"at":{"minimum":0,"type":"integer"},' +
  '"root":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},"required":["root","agents",' +
  '"at"],"title":"Delegated Identity","type":"object",' +
  '"x-implements":{"$link":"sha256:999f23fcd7bec7075e54bb5dea0d9c548bfe7261f95b911ed8e23d2f4188724f"}}}';
const delegatedIdentitySchemaLink = "sha256:66df1e064901ce479186e768ea5bc3013b1bf67c6140735f96b0eeed7fbd2a2d";
const keyText =
  '{"$schema":{"$link":"sha256:806f6c529a168ad41bc7deee10a1c67027f2332648fa29a7a5f33bff9d83f19d"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const keyLink = "sha256:5c8f964122280caf757367dee41bbfa6fd25be5fd70280ce2949ecbad76efa01";
const identityText =
  '{"$schema":{"$link":"sha256:22ad1b36ad3b46ada728ea6d6df738a1f306bf6917cef82d7c7a951709e1b422"},' +
  '"at":1767225600000,' +
  '"root":{"$link":"sha256:5c8f964122280caf757367dee41bbfa6fd25be5fd70280ce2949ecbad76efa01"}}';
const identityLink = "sha256:fbabefdf1d2020bd7c8da5ad3fddb1a9eb408ed1fe1b374a45f10ddb46257c96";
const signedIdentitySchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"identity":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"}},"required":["identity","signature"],' +
  '"title":"Signed Identity","type":"object"}}';
const signedIdentitySchemaLink = "sha256:6ff4089d10d54822ae943cd0d5d6c2122382d269c79e59306c2ea7a3c1db8ec2";
const signedIdentityText =
  '{"$schema":{"$link":"sha256:6ff4089d10d54822ae943cd0d5d6c2122382d269c79e59306c2ea7a3c1db8ec2"},' +
  '"identity":{"$link":"sha256:fbabefdf1d2020bd7c8da5ad3fddb1a9eb408ed1fe1b374a45f10ddb46257c96"},' +
  '"signature":"ca32524b421edba33e57e0f39be585a9d243fde02ef4662a616b880e48fd3ffb1499997e490aadf276dfdf0d284' +
  '97ab9061db5fad80635dfb335650c0a29f30d"}';
const signedIdentityLink = "sha256:db798bd9d9c764128778606fc3e0529f4104e3a2f37894512c4d7d73290ec4f5";
const signatureSchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"object":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"},' +
  '"signedIdentity":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},"required":["signedIdentity",' +
  '"object","signature"],"title":"Signature","type":"object"}}';
const signatureSchemaLink = "sha256:7090ce0b5950e2d59e4af998b51090059cff783b8f05b4c12817acbe36c573c4";
const signatureText =
  '{"$schema":{"$link":"sha256:7090ce0b5950e2d59e4af998b51090059cff783b8f05b4c12817acbe36c573c4"},' +
  '"object":{"$link":"sha256:7f0842ff8211ee8330f12285571af67d615bb76dbedaec6eb9b5ae9686fa2df4"},' +
  '"signature":"16ee674e6a0d4bfcea87e6a04bacba19b43d67e6e89501dd36e322ab5c2db74decf00cb9ddb82f4152e10033815' +
  '111447f479ee08896ae6900e5a2d038882e0e",' +
  '"signedIdentity":{"$link":"sha256:db798bd9d9c764128778606fc3e0529f4104e3a2f37894512c4d7d73290ec4f5"}}';
const signatureLink = "sha256:d5dcd6b8364fdabfb2ae49a92f0bfc2c84ca6da05748d606135fe440ae92278e";
const agentKeyTexts = [
  '{"$schema":{"$link":"sha256:806f6c529a168ad41bc7deee10a1c67027f2332648fa29a7a5f33bff9d83f19d"},' +
    '"publicKey":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394"}',
  '{"$schema":{"$link":"sha256:806f6c529a168ad41bc7deee10a1c67027f2332648fa29a7a5f33bff9d83f19d"},' +
    '"publicKey":"ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1"}',
] as const;
const agentKeyLinks = [
  "sha256:f4a86d57ad03dec7cfec4e0816efdc52a96569960a29f5b902b32345ce5f4c63",
  "sha256:b0ef6c084a50ccf9d89f93a2e5797e0382a29ca6444580bb13c78dc1dcac190b",
] as const;
const delegatedIdentityText =
  '{"$schema":{"$link":"sha256:66df1e064901ce479186e768ea5bc3013b1bf67c6140735f96b0eeed7fbd2a2d"},' +
  '"agents":[{"$link":"sha256:f4a86d57ad03dec7cfec4e0816efdc52a96569960a29f5b902b32345ce5f4c63"},' +
  '{"$link":"sha256:b0ef6c084a50ccf9d89f93a2e5797e0382a29ca6444580bb13c78dc1dcac190b"}],"at":1767225600000,' +
  '"root":{"$link":"sha256:5c8f964122280caf757367dee41bbfa6fd25be5fd70280ce2949ecbad76efa01"}}';
const delegatedIdentityLink = "sha256:63ce8817c4f6937bde2a1893004c18efabd0118c634ac68ab4b35949490c785c";
const delegatedSignedIdentityText =
  '{"$schema":{"$link":"sha256:6ff4089d10d54822ae943cd0d5d6c2122382d269c79e59306c2ea7a3c1db8ec2"},' +
  '"identity":{"$link":"sha256:63ce8817c4f6937bde2a1893004c18efabd0118c634ac68ab4b35949490c785c"},' +
  '"signature":"8c41a5e0bb102cfdbc848bc8bfbd291d9e579d5bdd8b770741263f35aaac8119351ee1744cecf9f937891d2753a' +
  'fe76d0acaa450e6cfa916b14f6dc59f3c4c01"}';
const delegatedSignedIdentityLink = "sha256:12b3b20d2d12c658a65fbe642e8393e1fe7190eb20fc67ccb9e161e88e5e9150";
const delegatedSignatureText =
  '{"$schema":{"$link":"sha256:7090ce0b5950e2d59e4af998b51090059cff783b8f05b4c12817acbe36c573c4"},' +
  '"object":{"$link":"sha256:7f0842ff8211ee8330f12285571af67d615bb76dbedaec6eb9b5ae9686fa2df4"},' +
  '"signature":"014d40b2d7884df44cadd004441524908ec240f1274fb39071698a338cc3ccd7245f213246e4b97d433f054e744' +
  '5c3dbb64d6869fe4c3523b8bfd3e20d1aa42807",' +
  '"signedIdentity":{"$link":"sha256:12b3b20d2d12c658a65fbe642e8393e1fe7190eb20fc67ccb9e161e88e5e9150"}}';
const delegatedSignatureLink = "sha256:88710701d32142d1435916d84df12c528868191d7c5ec75aa10d0c7357588414";

// The login object of the vector in @estoc/object.
const objectLink: Link<never> = "sha256:7f0842ff8211ee8330f12285571af67d615bb76dbedaec6eb9b5ae9686fa2df4";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);

test.each([
  ["Key", keyInterface, keyInterfaceLink],
  ["Identity", identityInterface, identityInterfaceLink],
] as const)("the %s interface is its name in UTF-8, with a fixed link", (name, { bytes, link }, expected) => {
  expect(text(bytes)).toBe(name);
  expect(link).toBe(expected);
});

test.each(keySchemas)(
  "the key schema of $scheme.name encodes to fixed bytes and a fixed link",
  async ({ scheme, text: expected, link }) => {
    const schema = await encodeSchema(scheme.keySchema, defaultValidator);
    expect(text(schema.bytes)).toBe(expected);
    expect(schema.link).toBe(link);
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
    const keySchema = await decodeSchema(utf8(ed25519KeySchemaText), defaultValidator);
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
