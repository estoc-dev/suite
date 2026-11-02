# @estoc/mailbox

A mailbox is where messages to someone can be sent. It is an object of
`@estoc/object` naming the key that messages to it are sealed to and where
a transport takes them. Holding a mailbox is enough to send: `mailboxFrom`
turns its bytes into a `Mailbox` that can `send`, and the sender does not
deal with keys, encryption or transports.

```
Mailbox  {"key": <x25519 public key>, <the transport's fields>…}
Message  a bundle of @estoc/bundle, packed
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
to it afterwards is turned back or lost, as any message can be. A
transport that knows the mailbox is retired turns it back as `gone`, and
one that finds nothing answering there as `later`. Moving is handing out a
new mailbox.

### The receiving side

The receiver makes a key for each mailbox, writes its public key into the
mailbox and keeps its secret. With a store, its post does both, as told
under "Through a store". Without one, the receiver keeps 32 random secret
bytes and makes a `MailboxKey` from them. It hands out the mailbox's bytes
as it sees fit: by hand or in a QR code, alone or with the signature of
whoever stands behind the mailbox.

```ts
import { encodeObject } from "@estoc/object";
import { MailboxKey } from "@estoc/mailbox";
import { hex } from "@scure/base";

const key = await MailboxKey.fromSecretKey(secretKey);
const mailbox = encodeObject(schema, { key: hex.encode(key.publicKey), name: queueName });
```

What is sent to a mailbox waits with its transport until the receiver is
done with it. The transport's receiving side hands it over as a `Pickup`
of one mailbox, which it makes with whatever it takes to receive there.
That differs from one transport to another, so a `Transport` is the
sending half alone.

```ts
interface Pickup {
  readonly mailbox: Link<EncodedObject<Json>>;
  arrivals(signal?: AbortSignal): AsyncIterable<Arrival>;
}

interface Arrival {
  readonly sealed: Uint8Array;
  drop(): Promise<void>;
}
```

`arrivals` gives what waits at the mailbox, each until it is done. It ends
once `signal` aborts, and, unless the transport waits for more to come,
once nothing more waits. `drop` lets the transport drop the sealed bytes.
A receiver is done with an arrival once it has kept what it holds, so one
that stops in between is given it again. A message so arrives at least
once, and one given again reads as one that arrived twice.

`open` takes the sealed bytes that a transport received and gives back the
bundle inside. It refuses bytes that do not open with its key, and what
opens but does not unpack to a bundle. It does not read who stands behind
the root: the receiver does that, against the object it expects, with
`signatures.read` and the bundle as the reader. A receiver that keeps the
versions it has seen passes its `Versions` in place of `noVersions`, and an
agent its root removed no longer reads as the root.

```ts
const bundle = await key.open(sealed);
const signature = await signatures.read(bundle.link, bundle, noVersions);
```

## Sending

```ts
import { mailboxFrom } from "@estoc/mailbox";

const mailbox = await mailboxFrom(handedOut, { transports: [transport] });
await mailbox.send(signature, [object.bytes, ...signature.signedIdentity.blobs]);
```

`mailboxFrom` takes the bytes of a mailbox alone; who stands behind it is
for the sender to read first, when that matters. It picks the transport
whose schema the mailbox is written to, and refuses a mailbox of any
transport it was not given. It checks `key` itself rather than trusting a
transport's schema to, and binds the key and the transport once. The
`Mailbox` it returns shows neither, only `send`.

`send` takes a root and blobs as `writeBundle` does, and refuses a root
that is not an object. It packs the bundle with `packBundle`, seals the
zip to the key and hands the sealed bytes to the transport. It resolves
once they are handed on. Nothing confirms that a message arrived and
nothing is sent again: a message can be lost, arrive twice, or arrive out
of order. That is harmless to a reader, since blobs are named by their
content and a reading only grows with what arrives; an application that
needs a message to be fresh puts a nonce in its object, as a login does.

When the transport cannot hand the sealed bytes on, `send` rejects with an
`UndeliveredMessage`, whose `kind` tells the sender what it can do:

| `kind`    | The sender                                                                 |
|-----------|----------------------------------------------------------------------------|
| `later`   | can send the same again later, as when the network is down or the box full |
| `gone`    | needs another mailbox, since this one takes nothing more                   |
| `refused` | cannot send this one there, as when it is too large, though others can go  |

When to send again is the application's to choose. A message turned back
for want of an answer may have arrived all the same, and sending it again
does no harm, as arriving twice does none.

## Through a store

`loadPost` binds sending and receiving to a store of `@estoc/store`, and
keeps the keys of the user's mailboxes in a private store beside it. What
is sent is taken from the store, what arrives is kept there, and each is
recorded as an object the user writes:

```
Inbound      {"bundle": <link of the root>, "mailbox": <link of the mailbox>, "at": <milliseconds>}
Outbound     the same fields, under a schema of its own
Mailbox Key  {"mailbox": <link of the mailbox>, "secret": <x25519 secret key>}, in the private store
```

The three schemas are `inboundSchema`, `outboundSchema` and
`mailboxKeySchema`. A key's `secret` is 32 bytes in lowercase hex.

```ts
import { loadPost } from "@estoc/mailbox";
import { MemoryBackend, PrivateStore } from "@estoc/store";

const keys = new PrivateStore(store, new MemoryBackend());
const post = await loadPost(store, keys, { transports: [transport], validator: defaultValidator });

const outbox = await post.outbox(theirs.link);
await outbox.send(signature.link); // the root and all it leads to in the store

const inbox = await post.openInbox((publicKey) =>
  encodeObject(schema, { key: hex.encode(publicKey), name: queueName }),
);
await inbox.collect(pickup); // each bundle that waits, kept with an Inbound record

const again = await post.inbox(inbox.key); // after a restart
```

Both mailboxes have to be in the store, since a record links to its
mailbox and a store takes in nothing without all it leads to. The sender
writes a mailbox handed to it, alone or in whatever record of the handing
the application keeps.

`openInbox` makes a new key and gives its public key to `make`, which gives
back a mailbox sealed to it, of one of the post's transports. The post
writes the mailbox to the store as the user's, and then the key to the
private store. A key is one mailbox's, so a key used at two transports
would be two. If the post stops in between, what is left is a mailbox that
nobody receives at and nobody was handed. The inbox's `mailbox` is the
link of the mailbox to hand out, and its `key` the link of the key.

`inbox` makes an inbox again from the link of its key, and refuses a key
whose secret is not of the public key its mailbox names: what that key
opens was sealed to another mailbox. The caller holds the link of a key and
not its secret, and no bundle gathered from the store carries one. The
package keeps no list of the user's mailboxes: an application finds them
with an index of `@estoc/store` over the private store that reads
`mailboxKeySchema`.

`send` takes a root that the store holds, whoever wrote it, so passing on
what came in is sending its root. It bundles the closure of the root,
schemas included, and writes `Outbound` once the transport takes the
bundle. When the transport cannot hand it on, `send` rejects with its
`UndeliveredMessage` and nothing is written, and the root is still there to
send again. Neither the zip nor the sealed bytes are kept: sending again seals
the same bundle afresh.

`receive` keeps the bundle and its `Inbound` record in one write. What does
not open with the key is refused, and so is a bundle that leaves out a
blob its root leads to and the store does not hold, record and all. Blobs
the root does not lead to are dropped.

`collect` takes a pickup of the inbox's mailbox, and refuses one of
another. It receives each arrival in turn, is done with it once the write
is through, and gives back the records it wrote. What it refuses is done
with too and leaves no record. A bundle that leaves out a blob would be
taken once the blob reaches the store, but `collect` does not keep it
waiting for that: a sender whose store holds the bundle can send it
again. When the store fails to write, `collect` stops and rejects without
being done with that arrival, which waits to be collected again. A stop
after the write and before `done` leaves the arrival waiting as well, and
collecting it again writes a second record of the same bundle.

### Reading what came and went

Each time something comes in or goes out is a record of its own, so a
message that arrives twice, or is sent again after it was lost, has two.
`at` is the clock of the device that wrote the record, and is no part of
the message. A reader takes the same `bundle` at the same `mailbox` as one
message, at the earliest `at`: the bundle is named by its root, which is
the same each time it is sent.

The package keeps no index of the records. An application keeps its own,
an index of `@estoc/store` that reads `inboundSchema` and `outboundSchema`.
The tests give each record the row `[direction, mailbox, at, bundle]`, and
read a conversation from two ranges, what came in at one mailbox and what
went out to the other, each bundle once at its first row. What a message
says and who signed it are read from its root when it is shown.

## Messages

A message is a bundle of `@estoc/bundle`: an object as the root, and the
blobs it leads to, which `readObject` and judgments such as
`signatures.read` in `@estoc/identity` take their blobs from. Nothing in it
names the sender. It travels packed, as a bundle travels between programs:
`send` packs it with `packBundle`, and `open` reads it with `unpackBundle`.
A packed bundle holds the same files as a bundle handed over as a file, so
a message can be kept as one and a bundle sent as a message.

A packed bundle is not compressed, so the length of the sealed bytes
depends on the sizes of its files alone, and anyone who seals to a
mailbox's key cannot make `open` unzip far more than arrived. `open` also
refuses a zip of more than 10,000 entries, though `send` sends it: what a
receiver takes is its own to limit, and a sender does not know it.

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
bytes, and resolves once they are handed on. When they cannot be, it
rejects with an `UndeliveredMessage` of the kind that it can tell from what
turned them back. How the receiver gets them, such as listening for
requests or fetching from a mailbox service, is the transport's own. Its
receiving side gives a `Pickup` for `Inbox.collect`, or hands sealed bytes
one at a time to `Inbox.receive`, or to `MailboxKey.open` without a store.
This package ships one transport, over HTTP, with no receiving side; its
tests also run on one in memory, whose queues give a pickup.

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
A 2xx response means they were handed on. 404 and 410 reject as `gone`,
408, 429 and 5xx as `later`, and any other response as `refused`. No response
rejects as `later`, and so does a redirect: it is not followed, since it
would take the bytes to a url the mailbox does not name, and a browser
does not tell it from no response. Nothing is sent again. No cookies or
other credentials and no referrer go with the request.

The receiving side is whatever serves the url, and this package ships none.
A mailbox service that keeps the bytes until the receiver fetches them
gives a `Pickup` of its own. A server of the receiver's passes the body of
each POST to `Inbox.receive`, or to `MailboxKey.open`, and answers 2xx
once it has kept the bytes, 503 while it cannot keep them, and 410 once it
no longer receives there. Anyone can post to it, so it limits how large a
body it takes, and answers 413 to one larger. One that browsers send to
answers their CORS preflight for a POST with
`Content-Type: application/octet-stream`, since browsers ask before
sending that type to another origin.
