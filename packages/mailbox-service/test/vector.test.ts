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
  pickupAnswerSchemaRead,
  pickupRequestSchemaRead,
  serviceSchemaRead,
  signer,
} from "./fixtures.ts";

// The bytes and the links were checked against Python's json module with
// sorted keys and no whitespace, which writes these values as JCS does, its
// hashlib, and the Ed25519 of its cryptography package for the secret key of
// 32 bytes of 1. Each schema is a document written to the root of JSON
// Schema. A change to the format changes them.
const rootLink = "sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326";
const schemaText = (document: string) => `{"$schema":{"$link":"${rootLink}"},"document":${document}}`;
const linkText =
  '{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}';
const serviceSchemaText = schemaText(
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    '"properties":{"at":{"minimum":0,"type":"integer"},"offers":{"items":{"additionalProperties":false,' +
    `"properties":{"acceptId":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},"offer":${linkText}},` +
    '"required":["offer","acceptId"],"type":"object"},"type":"array"},"origin":{"type":"string"}},' +
    '"required":["origin","at","offers"],"title":"Service","type":"object"}',
);
const serviceSchemaLink = "sha256:bb1d65f5142a43528963d808499bc33374531635cdc1050840ea259bb2e8e625";
const offerSchemaText = schemaText(
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    `"properties":{"identity":${linkText}},"required":["identity"],"title":"Account offer","type":"object"}`,
);
const offerSchemaLink = "sha256:42bb0114710faac6d0d962aa3dafe52f6a097930003a5f4dd6e2504f9e0b0205";
const acknowledgementSchemaText = schemaText(
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    `"properties":{"acceptance":${linkText},"at":{"minimum":0,"type":"integer"}},` +
    '"required":["acceptance","at"],"title":"Acknowledgement","type":"object"}',
);
const acknowledgementSchemaLink = "sha256:968f141b75fa769ad324e0e3a2dd072797ea7f316af02e92d8d76ff3262bd33d";
const offerText =
  '{"$schema":{"$link":"sha256:42bb0114710faac6d0d962aa3dafe52f6a097930003a5f4dd6e2504f9e0b0205"},' +
  '"identity":{"$link":"sha256:cfb93cd8b7d44611bdc136c3d6bb98c5204fa8e90d78d7fcc2233892b34405a9"}}';
const offerLink = "sha256:4dba771ea965e73671fa941632917e5edabf611dfca9d7e61e7c43934ee7496d";
const mailboxIdText = '{"pattern":"^[0-9a-f]{32}$","type":"string"}';
const mailboxOfferSchemaText = schemaText(
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    `"properties":{"identity":${linkText},"quota":{"minimum":1,"type":"integer"},` +
    '"retention":{"minimum":1,"type":"integer"},"size":{"minimum":1,"type":"integer"}},' +
    '"required":["identity","retention","quota","size"],"title":"Mailbox offer","type":"object"}',
);
const mailboxOfferSchemaLink = "sha256:2908406433dbb67ef15206ee245d6a803c279c857171b6d59e404eeff76143dc";
const mailboxRequestSchemaText = schemaText(
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    `"properties":{"key":{"pattern":"^[0-9a-f]{64}$","type":"string"},"offer":${linkText}},` +
    '"required":["offer","key"],"title":"Mailbox request","type":"object"}',
);
const mailboxRequestSchemaLink = "sha256:cdf7a50d0368b0f7539de32e4696549ad6a82946623a6b087d1d2809ec2d95b7";
const mailboxAcknowledgementSchemaText = schemaText(
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    `"properties":{"at":{"minimum":0,"type":"integer"},"pickupId":${mailboxIdText},` +
    `"request":${linkText},"sendId":${mailboxIdText}},` +
    '"required":["request","at","sendId","pickupId"],"title":"Mailbox acknowledgement","type":"object"}',
);
const mailboxAcknowledgementSchemaLink = "sha256:4d3cce4c4645d41d29cfb966fdc297c4d3a492c5b3c1a184cce31b3900bde8e9";
const pickupRequestSchemaText = schemaText(
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    `"properties":{"mailbox":${linkText},"receipts":{"items":${linkText},"type":"array"}},` +
    '"required":["mailbox","receipts"],"title":"Pickup request","type":"object"}',
);
const pickupRequestSchemaLink = "sha256:7ed4ad9e11d010b295ece58fd5dedbb0d88526894ea5bc3a2cbe52a7837ce18e";
const pickupAnswerSchemaText = schemaText(
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    `"properties":{"ciphertexts":{"items":${linkText},"type":"array"}},"required":["ciphertexts"],"title":"Pickup answer","type":"object"}`,
);
const pickupAnswerSchemaLink = "sha256:22f1abbff6d77e673e8776b65ae32470d2897a82ff57cef734f85d1e02f3e59e";
const mailboxOfferText =
  '{"$schema":{"$link":"sha256:2908406433dbb67ef15206ee245d6a803c279c857171b6d59e404eeff76143dc"},' +
  '"identity":{"$link":"sha256:cfb93cd8b7d44611bdc136c3d6bb98c5204fa8e90d78d7fcc2233892b34405a9"},' +
  '"quota":4096,"retention":60000,"size":1024}';
const mailboxOfferLink = "sha256:60d44e4b21fa19508e3c66d081c7191abb59316e1b7733c87f76a42dac91b556";

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
  ["pickup answer", pickupAnswerSchemaRead, pickupAnswerSchemaText, pickupAnswerSchemaLink],
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
