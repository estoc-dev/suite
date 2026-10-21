# @estoc/mailbox

A mailbox is where messages to someone can be sent. It is an object of
`@estoc/object` naming the key that messages to it are sealed to and where
a transport takes them. Holding a mailbox is enough to send: `mailboxFrom`
turns its bytes into a `Mailbox` that can `send`, and the sender does not
deal with keys, encryption or transports.

```
Mailbox  {"key": <x25519 public key>, "until"?: <RFC 3339 date-time>, <the transport's fields>…}
Message  {"blobs": [<base64url>, …], "entry": <base64url>}
Sealed   the HPKE encapsulated key, 32 bytes, followed by the ciphertext of a Message
```

## Mailboxes

Each transport writes its mailboxes to a draft 2020-12 schema of its own,
made with `mailboxSchema`. Every mailbox has `key`, an x25519 public key as
32 bytes in lowercase hex, and may have `until`. The transport adds its own
fields, such as a URL or a queue, and no other field is allowed. The title
tells apart two transports whose fields look the same.

```ts
import { encodeSchema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { mailboxSchema } from "@estoc/mailbox";

const schema = await encodeSchema(mailboxSchema("Memory mailbox", { name: { type: "string" } }, ["name"]), defaultValidator);
```

A mailbox means: messages sealed to `key` and carried by this transport to
this place reach whoever holds the key, until `until`. It does not name
whose it is. An identity stands behind a mailbox by signing it, as it signs
any object, and a mailbox nobody signs, such as a one-time invitation's,
can still be sent to. The key and the transport are written together, so a
new device, transport or key is another mailbox.

`until` is read as the instant that `Temporal.Instant.from` reads, as an
Authorization's is, and a mailbox takes messages while the sender's clock is
strictly before it. Without `until`, a mailbox does not end. There is no
revocation: to be able to retire a mailbox, give it a short `until` and hand
out a new one before it ends.

### The receiving side

The receiver keeps 32 random secret bytes, makes a `MailboxKey` from them,
and writes its public key into the mailbox. It hands out the mailbox's
bytes as it sees fit: by hand or in a QR code, alone or with the signature
of whoever stands behind the mailbox.

```ts
import { encodeObject } from "@estoc/object";
import { MailboxKey } from "@estoc/mailbox";
import { hex } from "@scure/base";

const key = await MailboxKey.fromSecretKey(secretKey);
const mailbox = encodeObject(schema, { key: hex.encode(key.publicKey), name: queueName, until: "2026-11-20T00:00:00Z" });
```

`open` takes the sealed bytes that a transport received and gives back the
Message inside. It refuses bytes that do not open with its key and
plaintext that is not a Message. It does not read who stands behind the
entry: the receiver does that, against the object it expects, with
`signatures.decode` or `readStanding`.

```ts
const message = await key.open(sealed);
```

## Sending

```ts
import { mailboxFrom } from "@estoc/mailbox";

const mailbox = await mailboxFrom(handedOut, { transports: [transport] });
await mailbox.send({ entry: signature.bytes, blobs: [object.bytes, signature.identity.bytes] });
```

`mailboxFrom` takes the bytes of a mailbox alone; who stands behind it is
for the sender to read first, when that matters. It picks the transport
whose schema the mailbox is written to, and refuses a mailbox of any
transport it was not given. It checks `key` and `until` itself rather than
trusting a transport's schema to, refuses a mailbox that has ended by the
clock, and binds the key and the transport once. The `Mailbox` it returns
shows neither, only `send`. The clock is the system's unless `clock` is
given.

`send` looks at `until` again by the clock at each send, and refuses once
the mailbox has ended. Otherwise it encodes the message, seals it to the
key and hands the sealed bytes to the transport. It resolves once they are
handed on. Nothing confirms that a message arrived and nothing is sent
again: a message can be lost, arrive twice, or arrive out of order. That
is harmless to a reader, since blobs are named by their content and a
reading only grows with what arrives; an application that needs a message
to be fresh puts a nonce in its object, as a login does.

## Messages

A message is an entry blob and the blobs it leads to, the shape that
`readStanding` in `@estoc/authorization` takes. Nothing in it names the
sender. It is encoded as the JCS ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785))
encoding of `{"blobs": […], "entry": …}`, each blob in unpadded base64url
([RFC 4648 §5](https://www.rfc-editor.org/rfc/rfc4648#section-5)), carried
as its bytes. The order of the blobs means nothing and a repeated blob is
harmless. `decodeMessage` refuses any other encoding. Base64url rather than
hex keeps a message a third smaller.

## Sealing

Messages are sealed with HPKE ([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180))
in base mode, with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-128-GCM.
The `info` is the UTF-8 of `Estoc Message` and the additional data is
empty. Sealed bytes are the 32-byte encapsulated key followed by the
ciphertext. `@hpke/core` does the work, on Web Crypto.

Every transport carries sealed bytes, even one that encrypts on its own:
a message is stored, passed on and can arrive late, so the layer from end
to end is the same whatever carries it.

## Who sent a message

Base mode seals to the receiver's key alone, so the sealed bytes do not say
who sealed them, and only the receiver's key opens them. A transport can
still learn who hands it sealed bytes, from the connection or from the
credentials it asks for.

A signature does not say who sent a message either. Anyone can pass on what
someone else signed, and passing on a signed contract is ordinary use; the
receiver reads who stands behind what it holds, not who sent it. An
application that needs to know whom a message was meant for, such as a
chat, writes the recipient into its own object, as `to`, so that it is
signed with the content.

Authenticated modes, such as HPKE's auth mode or DIDComm's authcrypt, are
not used: they need the sender to hold an x25519 key that the receiver
already knows, which a sender that has only been handed a mailbox does not
have.

## Transports

A transport is a plugin:

```ts
interface Transport {
  readonly schema: Schema;
  deliver(mailbox: JsonObject, sealed: Uint8Array): Promise<void>;
}
```

`deliver` takes the data of a mailbox written to `schema` and the sealed
bytes, resolves once they are handed on and rejects when they cannot be.
How the receiver gets them, such as listening for requests or fetching from
a relay, is the transport's own; it ends with the sealed bytes handed to
`MailboxKey.open`. This package ships no transport yet. Its tests run on
one in memory.
