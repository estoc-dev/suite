import { encodeObject } from "@estoc/object";
import { expect, test } from "vitest";
import { acknowledgementSchemaRead, identities, offerSchema, serviceSchemaRead, signer } from "./fixtures.ts";

// The bytes and the links were checked against Python's json module with
// sorted keys and no whitespace, which writes these values as JCS does, its
// hashlib, and the Ed25519 of its cryptography package for the secret key of
// 32 bytes of 1. A change to the format changes them.
const linkText =
  '{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}';
const serviceSchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"at":{"minimum":0,"type":"integer"},"offers":{"items":{"additionalProperties":false,' +
  `"properties":{"accept":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},"offer":${linkText}},` +
  '"required":["offer","accept"],"type":"object"},"type":"array"},"origin":{"type":"string"}},' +
  '"required":["origin","at","offers"],"title":"Service","type":"object"}';
const serviceSchemaLink = "sha256:fc96c061b840aef0bdd71bdc86a5531db9cd6067b3f8868f54b7fbc2fb11abd8";
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
  '{"$describedBy":{"$link":"sha256:6a481c3f3d8b65973933499e4d710891cf8306501eafc10ae813a411bd44981d"},' +
  '"identity":{"$link":"sha256:a6394ae7524f9c1ba37d4a86bdc80de04e38d98e0308df12a51a932763e64b22"}}';
const offerLink = "sha256:29eed5808328bb8ccad3d911b6c5790ecd0588942ed3041cb406ffb88a5f6246";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("the Service schema encodes to fixed bytes and a fixed link", () => {
  expect(text(serviceSchemaRead.bytes)).toBe(serviceSchemaText);
  expect(serviceSchemaRead.link).toBe(serviceSchemaLink);
});

test("the account offer schema encodes to fixed bytes and a fixed link", () => {
  expect(text(offerSchema.bytes)).toBe(offerSchemaText);
  expect(offerSchema.link).toBe(offerSchemaLink);
});

test("the acknowledgement schema encodes to fixed bytes and a fixed link", () => {
  expect(text(acknowledgementSchemaRead.bytes)).toBe(acknowledgementSchemaText);
  expect(acknowledgementSchemaRead.link).toBe(acknowledgementSchemaLink);
});

test("the offer of a service whose root is an Ed25519 key encodes to fixed bytes and a fixed link", () => {
  const root = identities.keys.encode(signer("ed25519", 1).key);
  const offer = encodeObject(offerSchema, { identity: { $link: root.link } });
  expect(text(offer.bytes)).toBe(offerText);
  expect(offer.link).toBe(offerLink);
});
