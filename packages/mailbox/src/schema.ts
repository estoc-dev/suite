import type { SignedIdentityObject } from "@estoc/identity";
import {
  DRAFT_2020_12,
  type EncodedObject,
  type Json,
  type JsonLink,
  type JsonObject,
  type JsonSchema,
  linkSchema,
} from "@estoc/object";

/**
 * The draft 2020-12 schema of one transport's mailboxes.
 *
 * - Every mailbox has `key`, the x25519 public key that messages to it are sealed to, as 32 bytes
 *   in lowercase hex.
 * - `properties` and `required` add the transport's own fields, and no other field is allowed.
 * - The title tells apart two transports whose fields look the same.
 *
 * @throws when `properties` names a field `key`.
 */
export function mailboxSchema(
  title: string,
  properties: Readonly<Record<string, JsonObject>>,
  required: readonly string[] = [],
): JsonSchema {
  if (Object.hasOwn(properties, "key")) throw new Error("key is a field of every mailbox");
  return {
    $schema: DRAFT_2020_12,
    title,
    type: "object",
    properties: { ...properties, key: { type: "string", pattern: "^[0-9a-f]{64}$" } },
    required: ["key", ...required],
    additionalProperties: false,
  };
}

/**
 * The draft 2020-12 schema of the key that opens what arrives at a mailbox
 * of the user's: the link of the mailbox, and `secret`, the x25519 secret
 * key as 32 bytes in lowercase hex. One is kept in a private store for each
 * mailbox, so a key used at two transports is two objects.
 */
export const mailboxKeySchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Mailbox Key",
  type: "object",
  properties: { mailbox: linkSchema, secret: { type: "string", pattern: "^[0-9a-f]{64}$" } },
  required: ["mailbox", "secret"],
  additionalProperties: false,
};

export type MailboxKeyData = {
  readonly mailbox: JsonLink<EncodedObject<Json>>;
  readonly secret: string;
};

/**
 * The draft 2020-12 schema of a record that a bundle, named by the link of its root, went out to a
 * mailbox. `at` is when, in milliseconds since the Unix epoch, by the clock of the device that wrote
 * the record.
 */
export const outboundSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Outbound",
  type: "object",
  properties: { bundle: linkSchema, mailbox: linkSchema, at: { type: "integer", minimum: 0 } },
  required: ["bundle", "mailbox", "at"],
  additionalProperties: false,
};

/** The data of an Outbound record, as `outboundSchema` describes it. */
export type OutboundData = {
  readonly bundle: JsonLink<never>;
  readonly mailbox: JsonLink<EncodedObject<Json>>;
  readonly at: number;
};

/**
 * The draft 2020-12 schema of a Mailbox Grant, which says at which mailboxes whoever signs it
 * takes messages from someone.
 *
 * - `to` is the link of that someone's signed identity, the identity version the signer holds
 *   when it signs.
 * - `mailboxes` are the links of the mailboxes. A grant with none says the signer no longer takes
 *   their messages.
 * - `at` is when, in milliseconds since the Unix epoch, by the signer's clock.
 */
export const mailboxGrantSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Mailbox Grant",
  type: "object",
  properties: {
    to: linkSchema,
    mailboxes: { type: "array", items: linkSchema },
    at: { type: "integer", minimum: 0 },
  },
  required: ["to", "mailboxes", "at"],
  additionalProperties: false,
};

/** The data of a Mailbox Grant, as `mailboxGrantSchema` describes it. */
export type MailboxGrantData = {
  readonly to: JsonLink<SignedIdentityObject>;
  readonly mailboxes: readonly JsonLink<EncodedObject<Json>>[];
  readonly at: number;
};
