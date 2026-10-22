# @estoc/mailbox

A mailbox is where messages to someone can be sent. It is an object of
`@estoc/object` naming the key that messages to it are sealed to and where
a transport takes them. Holding a mailbox is enough to send: `mailboxFrom`
turns its bytes into a `Mailbox` that can `send`, and the sender does not
deal with keys, encryption or transports.

```
Mailbox  {"key": <x25519 public key>, <the transport's fields>…}
Message  a bundle of @estoc/bundle, zipped without compression
Sealed   the HPKE encapsulated key, 32 bytes, followed by the ciphertext of a Message
```

## Mailboxes

Each transport writes its mailboxes to a draft 2020-12 schema of its own,
made with `mailboxSchema`. Every mailbox has `key`, an x25519 public key as
32 bytes in lowercase hex. The transport adds its own fields, such as a URL
or a queue, and no other field is allowed. The title tells apart two
transports whose fields look the same.

```ts
import { encodeSchema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { mailboxSchema } from "@estoc/mailbox";

const schema = await encodeSchema(mailboxSchema("Memory mailbox", { name: { type: "string" } }, ["name"]), defaultValidator);
```

A mailbox means: messages sealed to `key` and carried by this transport to
this place reach whoever holds the key. It does not name whose it is. An
identity stands behind a mailbox by signing it, as it signs any object,
and a mailbox nobody signs, such as a one-time invitation's, can still be
sent to. The key and the transport are written together, so a new device,
transport or key is another mailbox.

A mailbox has no end written in it, and there is no revocation. Whoever
receives at a mailbox retires it by no longer receiving there: what is sent
to it afterwards is refused by the transport or lost, as any message can
be. Moving is handing out a new mailbox.

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
const mailbox = encodeObject(schema, { key: hex.encode(key.publicKey), name: queueName });
```

`open` takes the sealed bytes that a transport received and gives back the
bundle inside. It refuses bytes that do not open with its key, and what
opens but is not the zip of a bundle. It does not read who stands behind
the root: the receiver does that, against the object it expects, with
`signatures.decode` or `readStanding` and the bundle as the blobs.

```ts
const bundle = await key.open(sealed);
const signature = signatures.decode(bundle.root, bundle);
```

## Sending

```ts
import { mailboxFrom } from "@estoc/mailbox";

const mailbox = await mailboxFrom(handedOut, { transports: [transport] });
await mailbox.send(signature, [object.bytes, signature.identity.bytes]);
```

`mailboxFrom` takes the bytes of a mailbox alone; who stands behind it is
for the sender to read first, when that matters. It picks the transport
whose schema the mailbox is written to, and refuses a mailbox of any
transport it was not given. It checks `key` itself rather than trusting a
transport's schema to, and binds the key and the transport once. The
`Mailbox` it returns shows neither, only `send`.

`send` takes a root and blobs as `writeBundle` does, and refuses a root
that is not an object. It zips the bundle, seals the zip to the key and
hands the sealed bytes to the transport. It resolves once they are handed
on. Nothing confirms that a message arrived and nothing is sent again: a
message can be lost, arrive twice, or arrive out of order. That is
harmless to a reader, since blobs are named by their content and a reading
only grows with what arrives; an application that needs a message to be
fresh puts a nonce in its object, as a login does.

## Messages

A message is a bundle of `@estoc/bundle`: an object as the root, and the
blobs it leads to, which semantics and `readStanding` in
`@estoc/authorization` take their blobs from. Nothing in it names the
sender. It travels as the zip that `zipBundle` writes with
`compress: false`, which holds the same files as a bundle handed over as a
file, so a message can be kept as one and a bundle sent as a message.

The zip is not compressed because it is encrypted next. How far DEFLATE
shrinks the files depends on what they hold, so when someone else writes
part of a message, the length of the sealed bytes could tell them whether
their part repeats something secret in the rest. Without compression the
length depends on the sizes of the files alone.

Anyone can seal to a mailbox's key, so `open` refuses a zip whose files
come to more bytes than the zip itself. A zip without compression is larger
than its files and is never refused for it, while a compressed one could
otherwise unzip to far more than arrived. `open` keeps the other limit of
`unzipBundle`, 10,000 entries, so a bundle of more blobs is refused when it
is opened, though `send` sends it: what a receiver takes is its own to
limit, and a sender does not know it.

## Sealing

Messages are sealed with HPKE ([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180))
in base mode, with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-128-GCM.
The `info` is the UTF-8 of `Estoc Message` and the additional data is
empty. Sealed bytes are the 32-byte encapsulated key followed by the
ciphertext of the zip. `@hpke/core` does the work, on Web Crypto.

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
  readonly schema: Schema<Json>;
  deliver(mailbox: JsonObject, sealed: Uint8Array): Promise<void>;
}
```

`deliver` takes the data of a mailbox written to `schema` and the sealed
bytes, resolves once they are handed on and rejects when they cannot be.
How the receiver gets them, such as listening for requests or fetching from
a relay, is the transport's own; it ends with the sealed bytes handed to
`MailboxKey.open`. This package ships one transport, over HTTP; its tests
also run on one in memory.

### HTTP

```ts
import { loadHttpTransport } from "@estoc/mailbox/http";

const http = await loadHttpTransport(defaultValidator);
const mailbox = await mailboxFrom(handedOut, { transports: [http] });
```

```
HTTP mailbox  {"key": <x25519 public key>, "url": <URL>}
```

The schema is titled `HTTP mailbox`. Its url starts with `https://`, or
with `http://` to the receiver's own machine: `localhost`, `127.0.0.1` or
`[::1]`, with or without a port. Sealed bytes cannot be read on the way,
but over plain http whoever is on the way sees when messages arrive and how
large they are, and can hold them back unnoticed. On one machine, as in
development or for a daemon beside the sender, no one is on the way.

`deliver` posts the sealed bytes to the url as `application/octet-stream`.
A 2xx response means they were handed on. Any other response, or none,
rejects, and nothing is sent again. A redirect is not followed, since it
would take the bytes to a url the mailbox does not name. No cookies or
other credentials and no referrer go with the request.

The receiving side is whatever serves the url, and this package ships
none; `@estoc/http-test-mailbox` is one for a single machine. It answers
2xx once it has kept the bytes, and they reach `MailboxKey.open` in the
end, whether the server holds the key or keeps them for the receiver to
fetch. Anyone can post to it, so it limits how large a body it takes. One that browsers send to answers their CORS preflight for a
POST with `Content-Type: application/octet-stream`, since browsers ask
before sending that type to another origin.
