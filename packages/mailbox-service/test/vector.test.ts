import { encodeObject } from "@estoc/object";
import { expect, test } from "vitest";
import { acknowledgementSchemaRead, identities, offerSchema, signer } from "./fixtures.ts";

// The bytes and the links were checked against Python's json module with
// sorted keys and no whitespace, which writes these values as JCS does, its
// hashlib, and the Ed25519 of its cryptography package for the secret key of
// 32 bytes of 1. A change to the format changes them.
const linkText =
  '{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}';
const offerSchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  `"properties":{"identity":${linkText}},"required":["identity"],"title":"Account offer","type":"object"}`;
const offerSchemaLink = "sha256:6a481c3f3d8b65973933499e4d710891cf8306501eafc10ae813a411bd44981d";
const acknowledgementSchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  `"properties":{"accepted":${linkText},"at":{"minimum":0,"type":"integer"}},` +
  '"required":["accepted","at"],"title":"Acknowledgement","type":"object"}';
const acknowledgementSchemaLink = "sha256:4e0f482aebf1cbc62db021aab83b61a62c11ccf79e0a0969a1e283631fbc591e";
const offerText =
  '{"$type":{"$link":"sha256:6a481c3f3d8b65973933499e4d710891cf8306501eafc10ae813a411bd44981d"},' +
  '"identity":{"$link":"sha256:3d52c9daa7ce3a7b07d4f155e33b08374b14e82f3d05c14f718d64d3552d6e1c"}}';
const offerLink = "sha256:224809480d6cc847888af3719e93d083b1a036eba79249342bd6cb9dedb763ed";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("the account offer schema encodes to fixed bytes and a fixed link", () => {
  expect(text(offerSchema.bytes)).toBe(offerSchemaText);
  expect(offerSchema.link).toBe(offerSchemaLink);
});

test("the acknowledgement schema encodes to fixed bytes and a fixed link", () => {
  expect(text(acknowledgementSchemaRead.bytes)).toBe(acknowledgementSchemaText);
  expect(acknowledgementSchemaRead.link).toBe(acknowledgementSchemaLink);
});

test("the offer of an Ed25519 identity encodes to fixed bytes and a fixed link", () => {
  const identity = identities.encode(signer("ed25519", 1).identity);
  const offer = encodeObject(offerSchema, { identity: { $link: identity.link } });
  expect(text(offer.bytes)).toBe(offerText);
  expect(offer.link).toBe(offerLink);
});
