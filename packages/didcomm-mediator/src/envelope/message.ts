import { canonicalDid, type DidResolver, didOf, keysOf, type Relationship, sameDid } from "./did.ts";
import { isObject, type JsonObject, parseObject, textOf, utf8 } from "./encoding.ts";
import { anoncrypt, authcrypt, type ContentEncryption, decrypt, type Jwe } from "./jwe.ts";
import { sign, verify } from "./jws.ts";
import { agrees, type NamedKey, type OwnKey, type PublicKey, type Secrets } from "./keys.ts";

/** A DIDComm plaintext message. Headers this does not know are kept. */
export interface Message {
  readonly id: string;
  readonly type: string;
  readonly from?: string;
  readonly to?: readonly string[];
  readonly body?: JsonObject;
  readonly [header: string]: unknown;
}

export type Envelope =
  | { readonly kind: "anoncrypt"; readonly recipient: string; readonly enc: ContentEncryption }
  | { readonly kind: "authcrypt"; readonly recipient: string; readonly sender: string }
  | { readonly kind: "signed"; readonly signer: string; readonly jws: string };

export interface Unpacked {
  readonly message: Message;
  /** The envelopes around the message, outermost first. */
  readonly envelopes: readonly Envelope[];
  /**
   * The DID the message is proven to come from, by authcrypt or by a
   * signature, in the form that names it; none when nothing proves one.
   */
  readonly sender: string | undefined;
}

export interface UnpackOptions {
  readonly resolver: DidResolver;
  readonly secrets: Secrets;
}

async function keyOf(resolver: DidResolver, kid: string, relationship: Relationship): Promise<PublicKey | undefined> {
  const document = await resolver.resolve(didOf(kid));
  if (document === undefined) return undefined;
  return keysOf(document, relationship).find((named) => named.kid === kid)?.key;
}

function messageOf(object: JsonObject): Message {
  const { id, type, from, to, body } = object;
  if (typeof id !== "string" || id === "") throw new Error("the message has no id");
  if (typeof type !== "string") throw new Error("the message has no type");
  if (from !== undefined && typeof from !== "string") throw new Error("the message's from is not a string");
  if (to !== undefined && !(Array.isArray(to) && to.every((item) => typeof item === "string"))) {
    throw new Error("the message's to is not a list of strings");
  }
  if (body !== undefined && !isObject(body)) throw new Error("the message's body is not an object");
  return object as Message;
}

// The envelopes allowed around one message, outermost first, each at most
// once. The spec lists anoncrypt, authcrypt, anoncrypt(sign),
// authcrypt(sign), anoncrypt(authcrypt) and sign alone; its test vectors
// also have anoncrypt(authcrypt(sign)), which this order admits.
const order: Envelope["kind"][] = ["anoncrypt", "authcrypt", "signed"];

/**
 * Takes the envelopes off a DIDComm message and checks that they agree:
 * an authcrypt sender and a signer are the message's `from`, and a message
 * that is both signed and encrypted names its recipient in `to`. Whatever
 * an authenticated sender put in `to` must name each recipient that
 * decrypted it. Only anoncrypt proves nothing, so neither is checked then.
 */
export async function unpack(packed: string, { resolver, secrets }: UnpackOptions): Promise<Unpacked> {
  const envelopes: Envelope[] = [];
  let text = packed;
  let message: Message | undefined;
  while (message === undefined) {
    const object = parseObject(text, "the message");
    let envelope: Envelope;
    if (object.ciphertext !== undefined) {
      const opened = await decrypt(object, secrets, (skid) => keyOf(resolver, skid, "keyAgreement"));
      envelope =
        opened.sender === undefined
          ? { kind: "anoncrypt", recipient: opened.recipient, enc: opened.enc }
          : { kind: "authcrypt", recipient: opened.recipient, sender: opened.sender };
      text = textOf(opened.plaintext);
    } else if (object.payload !== undefined) {
      const verified = await verify(object, (kid) => keyOf(resolver, kid, "authentication"));
      envelope = { kind: "signed", signer: verified.signer, jws: text };
      text = textOf(verified.payload);
    } else {
      message = messageOf(object);
      break;
    }
    const last = envelopes.at(-1);
    if (last !== undefined && order.indexOf(envelope.kind) <= order.indexOf(last.kind)) {
      throw new Error(`a ${envelope.kind} message inside a ${last.kind} one is not allowed`);
    }
    envelopes.push(envelope);
  }

  let sender: string | undefined;
  for (const envelope of envelopes) {
    if (envelope.kind === "anoncrypt") continue;
    const kid = envelope.kind === "authcrypt" ? envelope.sender : envelope.signer;
    if (message.from === undefined || !sameDid(message.from, didOf(kid))) {
      throw new Error(`the message's from is not the DID of ${kid}`);
    }
    sender ??= canonicalDid(didOf(kid));
  }
  const recipients = envelopes.flatMap((envelope) => (envelope.kind === "signed" ? [] : [envelope.recipient]));
  const signed = envelopes.some((envelope) => envelope.kind === "signed");
  if (signed && recipients.length > 0 && message.to === undefined) {
    throw new Error("a signed message that is encrypted has no to");
  }
  if (sender !== undefined && message.to !== undefined) {
    const to = message.to;
    for (const recipient of recipients) {
      if (!to.some((did) => sameDid(did, didOf(recipient))))
        throw new Error(`the message's to does not name ${recipient}`);
    }
  }
  return { message, envelopes, sender };
}

export interface PackOptions {
  /** The DID to encrypt to, by its key agreement keys on one curve. */
  readonly to: string;
  /** Authcrypts from this DID, by the first of its key agreement keys held in `secrets` that agrees with `to`. */
  readonly from?: string;
  /** Signs as this DID, by the first of its authentication keys held in `secrets` that signs; then anoncrypts. */
  readonly signBy?: string;
  /** Anoncrypts the authcrypted message again, so only the recipient sees `skid`. */
  readonly protectSender?: boolean;
  /** The content encryption of anoncrypt. */
  readonly enc?: ContentEncryption;
  readonly resolver: DidResolver;
  readonly secrets: Secrets;
}

async function keysOfDid(resolver: DidResolver, did: string, relationship: Relationship): Promise<NamedKey[]> {
  const document = await resolver.resolve(did);
  if (document === undefined) throw new Error(`${did} does not resolve`);
  return keysOf(document, relationship);
}

function held(keys: readonly NamedKey[], secrets: Secrets): OwnKey[] {
  return keys.flatMap(({ kid }) => {
    const secret = secrets(kid);
    return secret === undefined ? [] : [{ kid, secret }];
  });
}

/**
 * Encrypts a message to a DID: authcrypted when `from` is given, or signed
 * and anoncrypted when `signBy` is, or anoncrypted alone. Authcrypt of a
 * signed message adds nothing, as the spec says, and is not written.
 */
export async function packEncrypted(message: Message, options: PackOptions): Promise<string> {
  const { to, from, signBy, resolver, secrets } = options;
  messageOf(message);
  if (from !== undefined && signBy !== undefined) throw new Error("a message is authcrypted or signed, not both");
  const author = from ?? signBy;
  if (author !== undefined && (message.from === undefined || !sameDid(message.from, author))) {
    throw new Error(`the message's from is not ${author}`);
  }
  if (signBy !== undefined && !message.to?.some((did) => sameDid(did, to))) {
    throw new Error(`a signed message that is encrypted names ${to} in its to`);
  }

  let payload = utf8(JSON.stringify(message));
  if (signBy !== undefined) {
    const signer = held(await keysOfDid(resolver, signBy, "authentication"), secrets).find(
      (key) => key.secret.algorithm !== undefined,
    );
    if (signer === undefined) throw new Error(`no authentication key of ${signBy} that signs is held here`);
    payload = utf8(JSON.stringify(sign(payload, signer)));
  }

  const keys = (await keysOfDid(resolver, to, "keyAgreement")).filter((named) => agrees(named.key.curve));
  const onCurve = (curve: string) => keys.filter((named) => named.key.curve === curve);
  let jwe: Jwe;
  if (from === undefined) {
    const [first] = keys;
    if (first === undefined) throw new Error(`${to} has no key agreement key`);
    jwe = anoncrypt(payload, onCurve(first.key.curve), options.enc);
  } else {
    const sender = held(await keysOfDid(resolver, from, "keyAgreement"), secrets).find(
      (key) => onCurve(key.secret.curve).length > 0,
    );
    if (sender === undefined) throw new Error(`no key agreement key of ${from} on a curve of ${to} is held here`);
    const recipients = onCurve(sender.secret.curve);
    jwe = authcrypt(payload, sender, recipients);
    if (options.protectSender) jwe = anoncrypt(utf8(JSON.stringify(jwe)), recipients, options.enc);
  }
  return JSON.stringify(jwe);
}
