import { ed25519 } from "@estoc/identity";
import { encodeObject } from "@estoc/object";
import { expect, test } from "vitest";
import {
  acknowledgementSchemaRead,
  keys,
  mailboxAcknowledgementSchemaRead,
  mailboxOfferSchemaRead,
  mailboxRequestSchemaRead,
  offerSchema,
  pickupRequestSchemaRead,
  serviceSchemaRead,
  signer,
  waitingSchemaRead,
} from "./fixtures.ts";

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
  `"properties":{"acceptance":${linkText},"at":{"minimum":0,"type":"integer"}},` +
  '"required":["acceptance","at"],"title":"Acknowledgement","type":"object"}';
const acknowledgementSchemaLink = "sha256:a6f5260e29ece9b0a3aefe53e59aca509d491a77a9f0d5ff614699f3fbf80a48";
const offerText =
  '{"$describedBy":{"$link":"sha256:6a481c3f3d8b65973933499e4d710891cf8306501eafc10ae813a411bd44981d"},' +
  '"identity":{"$link":"sha256:ecc75ffb48855e212f07f6a1bfe71da1e95e47d8f159a0354438ca6fefb90358"}}';
const offerLink = "sha256:70268cbdf530023b939e533b17e5b7b772a881af97de568984903616ef2dd4e5";
const mailboxIdText = '{"pattern":"^[0-9a-f]{32}$","type":"string"}';
const mailboxOfferSchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  `"properties":{"identity":${linkText},"quota":{"minimum":1,"type":"integer"},` +
  '"retention":{"minimum":1,"type":"integer"},"size":{"minimum":1,"type":"integer"}},' +
  '"required":["identity","retention","quota","size"],"title":"Mailbox offer","type":"object"}';
const mailboxOfferSchemaLink = "sha256:ad1727ae08f6191ad1e948a152d6350e71bbdc254fe40497ca5d40b6ef91edc5";
const mailboxRequestSchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  `"properties":{"key":{"pattern":"^[0-9a-f]{64}$","type":"string"},"offer":${linkText}},` +
  '"required":["offer","key"],"title":"Mailbox request","type":"object"}';
const mailboxRequestSchemaLink = "sha256:4bc433acf28fc6b61a5368358448d604df093f58bf449749b16937eaaa3fb259";
const mailboxAcknowledgementSchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  `"properties":{"at":{"minimum":0,"type":"integer"},"pickup":${mailboxIdText},` +
  `"request":${linkText},"send":${mailboxIdText}},` +
  '"required":["request","at","send","pickup"],"title":"Mailbox acknowledgement","type":"object"}';
const mailboxAcknowledgementSchemaLink = "sha256:2e11a6fb908570b6fb5f0a9b72654db36d6d930c8f309bac82d9f171e0fd2402";
const pickupRequestSchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  `"properties":{"done":{"items":${linkText},"type":"array"},"mailbox":${linkText}},` +
  '"required":["mailbox","done"],"title":"Pickup request","type":"object"}';
const pickupRequestSchemaLink = "sha256:9b296e0ad53e2719ca81dd69e6c1780a8c645e98de1bc6fbe68242a37aa7dafa";
const waitingSchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  `"properties":{"sealed":{"items":${linkText},"type":"array"}},"required":["sealed"],"title":"Waiting","type":"object"}`;
const waitingSchemaLink = "sha256:26a182b48c9cde0050eb307494b45c2149a35f9a2ad0359d96f8f1431b020828";
const mailboxOfferText =
  '{"$describedBy":{"$link":"sha256:ad1727ae08f6191ad1e948a152d6350e71bbdc254fe40497ca5d40b6ef91edc5"},' +
  '"identity":{"$link":"sha256:ecc75ffb48855e212f07f6a1bfe71da1e95e47d8f159a0354438ca6fefb90358"},' +
  '"quota":4096,"retention":60000,"size":1024}';
const mailboxOfferLink = "sha256:ecac8cc2f39a0e69d5447406ab16958fa6d0f9fc504994c3ce643b4cae278afd";

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
  const root = keys.encode(signer(ed25519, 1).key);
  const offer = encodeObject(offerSchema, { identity: { $link: root.link } });
  expect(text(offer.bytes)).toBe(offerText);
  expect(offer.link).toBe(offerLink);
});

test.each([
  ["mailbox offer", mailboxOfferSchemaRead, mailboxOfferSchemaText, mailboxOfferSchemaLink],
  ["mailbox request", mailboxRequestSchemaRead, mailboxRequestSchemaText, mailboxRequestSchemaLink],
  [
    "mailbox acknowledgement",
    mailboxAcknowledgementSchemaRead,
    mailboxAcknowledgementSchemaText,
    mailboxAcknowledgementSchemaLink,
  ],
  ["pickup request", pickupRequestSchemaRead, pickupRequestSchemaText, pickupRequestSchemaLink],
  ["Waiting", waitingSchemaRead, waitingSchemaText, waitingSchemaLink],
])("the %s schema encodes to fixed bytes and a fixed link", (_, schema, bytes, link) => {
  expect(text(schema.bytes)).toBe(bytes);
  expect(schema.link).toBe(link);
});

test("the offer of mailboxes of a service whose root is an Ed25519 key encodes to fixed bytes and a fixed link", () => {
  const root = keys.encode(signer(ed25519, 1).key);
  const offer = encodeObject(mailboxOfferSchemaRead, {
    identity: { $link: root.link },
    retention: 60_000,
    quota: 4096,
    size: 1024,
  });
  expect(text(offer.bytes)).toBe(mailboxOfferText);
  expect(offer.link).toBe(mailboxOfferLink);
});
