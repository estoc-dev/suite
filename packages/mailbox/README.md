# @estoc/mailbox

A mailbox is where messages to someone can be sent. It is an object of
`@estoc/object` naming the key that messages to it are sealed to and where
a transport takes them. Holding a mailbox is enough to send: `mailboxFrom`
turns its bytes into a `Mailbox` that can `send`, and the sender does not
deal with keys, encryption or transports.

```
Mailbox     {"key": <x25519 public key>, <the transport's fields>…}
Message     a bundle of @estoc/bundle, packed
Ciphertext  the HPKE encapsulated key, 32 bytes, followed by HPKE's ciphertext of a Message
```

## Mailboxes

Each transport writes its mailboxes to a schema of its own, made with
`mailboxSchema`. Every mailbox has `key`, an x25519 public key as 32 bytes
in lowercase hex. The transport adds its own fields, such as a URL or a
queue, and a mailbox holds no other. The title tells apart two transports
whose fields look the same.

```ts
import { mailboxSchema } from "@estoc/mailbox";
import { string } from "@estoc/schema";

const schema = mailboxSchema("Memory mailbox", { name: string() });
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
  readonly ciphertext: Uint8Array;
  drop(): Promise<void>;
}
```

`arrivals` gives what waits at the mailbox, each until it is done. It ends
once `signal` aborts, and, unless the transport waits for more to come,
once nothing more waits. `drop` lets the transport drop the ciphertext.
A receiver is done with an arrival once it has kept what it holds, so one
that stops in between is given it again. A message so arrives at least
once, and one given again reads as one that arrived twice.

`open` takes a ciphertext that a transport received and gives back the
bundle inside. It refuses a ciphertext that does not open with its key, and what
opens but does not unpack to a bundle. It does not read who stands behind
the root: the receiver does that, against the object it expects, with
`signatures.read` and the bundle as the reader. A receiver that keeps the
identity versions it has seen passes its `SeenIdentityVersions` in place of
`noIdentityVersions`, and an agent its root removed no longer reads as the
one it signed for.

```ts
const bundle = await key.open(ciphertext);
const signature = await signatures.read(bundle.link, bundle, noIdentityVersions);
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
zip to the key and hands the ciphertext to the transport. It resolves
once it is handed on. Nothing confirms that a message arrived and
nothing is sent again: a message can be lost, arrive twice, or arrive out
of order. That is harmless to a reader, since blobs are named by their
content and a reading only grows with what arrives; an application that
needs a message to be fresh puts a nonce in its object, as a login does.

When the transport cannot hand the ciphertext on, `send` rejects with an
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

A `Post` binds sending and receiving to a store of `@estoc/store`, and
keeps the keys of the user's mailboxes in a private store beside it. What
is sent is taken from the store, what arrives is kept there, and each is
recorded as an object the user writes:

```
Inbound      {"bundle": <link of the root>, "at": <milliseconds>, "via": <link of the mailbox>}
Outbound     {"bundle": <link of the root>, "mailbox": <link of the mailbox>, "at": <milliseconds>}
Mailbox Key  {"mailbox": <link of the mailbox>, "secret": <x25519 secret key>}, in the private store
```

`Inbound` is the record of `@estoc/store` for whatever comes from outside a
store, with the mailbox as its channel, and `inboundSchema` is exported from
there. The other two schemas are `outboundSchema` and `mailboxKeySchema`. A
key's `secret` is 32 bytes in lowercase hex.

```ts
import { Post } from "@estoc/mailbox";
import { MemoryBackend, PrivateStore } from "@estoc/store";

const privateStore = new PrivateStore(store, new MemoryBackend());
const post = new Post(store, privateStore, { transports: [transport] });

const outbox = await post.outbox(theirs.link);
await outbox.send(signature.link); // the root and its closure in the store

const inbox = await post.openInbox((publicKey) =>
  encodeObject(schema, { key: hex.encode(publicKey), name: queueName }),
);
await inbox.collect(pickup); // each bundle that waits, kept with an Inbound record

const again = await post.inbox(inbox.key); // after a restart
```

Both mailboxes have to be in the store, since a record links to its
mailbox and a store takes in nothing without its closure. A mailbox handed
to the sender comes from outside the store, so the sender keeps it with an
`Intake` of `@estoc/store`, as the root of a bundle or in the closure of one,
such as the signature of whoever stands behind it. `post.outbox` takes its
link all the same.

```ts
import { readBundle, writeBundle } from "@estoc/bundle";
import { Intake } from "@estoc/store";

const intake = new Intake(store);
await intake.receive(readBundle(writeBundle({ bytes: handedOut }, [transport.schema.bytes])));
```

`openInbox` makes a new key and gives its public key to `makeMailbox`,
which gives back a mailbox sealed to it, of one of the post's transports.
The post writes the mailbox to the store as a record, and then the key to
the private store. A key is one mailbox's, so a key used at two transports
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
send again. Neither the zip nor the ciphertext is kept: sending again
seals the same bundle afresh.

`receive` hands the bundle to the store's `Intake`, which keeps it and its
`Inbound` record in one write, and the delivery it gives back names the
mailbox. What does not open with the key is refused, and so is a bundle
that leaves out a blob in its root's closure that the store does not hold,
record and all. Blobs outside the root's closure are dropped.

`collect` takes a pickup of the inbox's mailbox, and refuses one of
another. It receives each arrival in turn and gives back the records it
wrote.

- It is done with an arrival once the write is through.
- What it refuses is done with too and leaves no record. A bundle that
  leaves out a blob would be taken once the blob reaches the store, but
  `collect` does not keep it waiting for that: a sender whose store holds
  the bundle can send it again.
- When the store fails to write, `collect` stops and rejects without being
  done with that arrival, which waits to be collected again.
- A stop after the write and before `drop` leaves the arrival waiting as
  well, and collecting it again writes a second record of the same bundle.

### Reading what came and went

Each time something comes in or goes out is a record of its own, so a
message that arrives twice, or is sent again after it was lost, has two.
`at` is the clock of the device that wrote the record, and is no part of
the message. A reader takes the same `bundle` at the same mailbox as one
message, at the earliest `at`: the bundle is named by its root, which is
the same each time it is sent.

The package keeps no index of the records. An application keeps its own,
an index of `@estoc/store` that reads `inboundSchema` of that package and
`outboundSchema` of this one. The tests give each record a row of its
`direction`, `mailbox`, `at` and `bundle`, in the order of those fields, where
the mailbox of an `Inbound` is its
`via`, which is the mailbox's link for what came in at one, and one without
`via` gives no row. They
read a conversation from two ranges, what came in at one mailbox and what
went out to the other, each bundle once at its first row. What a message
says and who signed it are read from its root when it is shown.

## Messages

A message is a bundle of `@estoc/bundle`: an object as the root, and the
blobs in its closure, which `readObject` and verifiers such as
`signatures.read` in `@estoc/identity` take their blobs from. Nothing in it
names the sender. It travels packed, as a bundle travels between programs:
`send` packs it with `packBundle`, and `open` reads it with `unpackBundle`.
A packed bundle holds the same files as a bundle handed over as a file, so
a message can be kept as one and a bundle sent as a message.

A packed bundle is not compressed, so the length of the ciphertext
depends on the sizes of its files alone, and anyone who seals to a
mailbox's key cannot make `open` unzip far more than arrived. `open` also
refuses a zip of more than 10,000 entries, though `send` sends it: what a
receiver takes is its own to limit, and a sender does not know it.

## Sealing

Messages are sealed with HPKE ([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180))
in base mode, with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-128-GCM.
The `info` is the UTF-8 of `Estoc Message` and the additional data is
empty. A ciphertext is the 32-byte encapsulated key followed by HPKE's
ciphertext of the zip. `@hpke/core` does the work, on Web Crypto.

Every transport carries ciphertexts, even one that encrypts on its own:
a message is stored, passed on and can arrive late, so the layer from end
to end is the same whatever carries it.

## Who sent a message

Base mode seals to the receiver's key alone, so a ciphertext does not say
who sealed it, and only the receiver's key opens it. A transport can
still learn who hands it a ciphertext, from the connection or from the
credentials it asks for.

A signature does not say who sent a message either. Anyone can pass on what
someone else signed, and passing on a signed contract is ordinary use; the
receiver reads who stands behind what it holds, not who sent it. An
application that needs to know whom a message was meant for, such as a
chat, writes the recipient into its own object, as `to`, so that it is
signed with the content. Two people who have given each other grants read
what comes in by those grants, as told under "Corresponding".

Authenticated modes, such as HPKE's auth mode or DIDComm's authcrypt, are
not used. A store keeps the bundle and not the ciphertext, so what such a
mode says of who sealed it is gone once `open` has run, and a reader that
comes to the bundle later has only the signature to go by.

## Mailbox Grants

```
Mailbox Grant  {"to": <link of a signed identity>, "mailboxes": [<link of a mailbox>, …], "at": <milliseconds>}, signed
```

A Mailbox Grant says at which mailboxes whoever signs it takes messages
from someone. `to` is that someone's signed identity, the identity version
the signer holds when it signs, and `at` is when, by the signer's clock. The
signer writes its signature over the grant as a record, which is its own
account of where it takes whose messages, and sends the signature, with
its closure, to the one the grant is to, or hands it over out of band. That
one keeps it through an `Intake`, as `Inbox.receive` does, and then sends to
those mailboxes. A grant with no mailboxes says that the signer no longer
takes their messages. The schema is `mailboxGrantSchema`.

The grants of someone to someone else are a series, by the identifier of the
signer and that of `to`. Of the grants of a series whose signatures are
honored by the `SeenIdentityVersions` a reader gives, the latest is the one
with the greatest `at`, and of two at one `at`, the one whose signature has the
greater link, as with identity versions in `@estoc/identity`. Each side picks
the latest from the grants and identity versions it has seen. The two agree
on where messages go when they pick the same link, which they can compare
without asking a transport whether a mailbox still takes them.
`to` says which series a grant is of and grants nothing by itself: a grant
to someone else that is passed on to you is of their series, and does not
change where its signer takes your messages.

### Corresponding

`correspondenceAs` binds a post to an actor, to give grants and to send and
read by them. It reads the grants and identity versions the store holds at
each call, through indexes it makes once, so a program makes it once for an
actor.

```ts
const correspondence = post.correspondenceAs(actor, identity);

const inbox = await post.openInbox(makeMailbox);
const signature = await correspondence.grant(theirs, [inbox.mailbox]);
await correspondence.send(theirs, signature.link); // or hand it over out of band

await correspondence.send(theirs, line.link);
const message = await correspondence.messageAt(inbox.mailbox, bundle);
```

`grant` signs a grant, at the post's clock, to the current identity version
of `theirs` that the store holds, and writes the signature as a record. It
refuses a mailbox the store does not hold, and writes nothing then.

`send` sends a root that the store holds to each mailbox of the latest grant
of theirs to the actor, and gives back a record for each mailbox that takes it.

- They take messages at each of those mailboxes, so the message has gone once
  one of them takes it. A mailbox that turns it back leaves no record and does
  not stop the others.
- When no grant is honored, or the latest names no mailbox, it rejects
  with an `UndeliveredMessage` of kind `gone`, since another mailbox is needed.
- When every mailbox turns it back, it rejects with an `UndeliveredMessage`, of
  kind `later` if there is one.
- When the post has no transport for one of the mailboxes, it rejects before
  sending anything.

`messageAt` takes a mailbox and the link of a bundle that came in there, as an
application's index reads them from `Inbound`, and gives the signature at the
root of the bundle when it is honored as a message from whoever signed it. For
that, `asTakenIn` of the reader's people honors the signature, and the mailbox
is in a grant the actor gave them that it honors too. Anything
else gives `undefined`, since `collect` keeps whatever opens and anyone can
send to a mailbox. A store that fails to give a blob makes it reject.

What is honored is worked out when it is read, by what the store holds then and
the order it took it in:

- An earlier grant is honored as the latest is, so what came in before a move
  still reads as theirs.
- A grant with no mailboxes stops them sending and does not take back the
  earlier grants. A mailbox that was given to one person retires by no longer
  receiving there. What comes in at one that was given to several is still
  honored from each, whichever of them has been told to stop.
- A message, and each grant, is honored as the store took it in, by the
  identity versions it held then. Once the store holds an identity version
  that removes an agent, what that agent signs is no longer honored, whichever
  identity version it carries, while what came in before still is.
- A crisis cuts what came in before as well: messages and grants signed by an
  identity version before it. A grant that a key it lists signs gives the
  mailbox again, and the messages the crisis cut stay cut.

Two people who have not met hand over what it takes out of band. One hands over
their signed identity, as a bundle whose root it is, and the other a grant to
them, whose closure says who signed it and where to send. The first keeps that
through an `Intake`, and sends their own grant to the mailbox it names, and from
then on all goes through their mailboxes. A grant names whom it is to, so one
that leaks lets no one else in, and nothing has to be used only once. What is
left to trust is that the signed identity handed over is theirs, which the
channel out of band answers for.

Moving to another mailbox is signing a grant that lists it beside the old one,
and sending that. When to sign one without the old mailbox and stop receiving
there is the signer's to choose. What is sent to the old one after that is lost,
as any message can be.

### Reading grants

```ts
import { MailboxGrants } from "@estoc/mailbox";
import { indexOverBlobs, view } from "@estoc/store";

const grants = new MailboxGrants({ signatures, signedIdentities });
const seen = indexOverBlobs(identityVersions.selection, identityVersions.schema, (identityVersion) => [
  identityVersion,
]).orderedBy(...identityVersions.order);
const series = await view(store, grants.series);
const people = await view(store, { index: seen, read: (rows, reader) => identityVersions.people(rows, reader) });
await series.grantFrom(mine, their, people.asTakenIn); // where I take their messages
await series.grantFrom(their, mine, people.asTakenIn); // where they take mine
```

`grants.series` is a `View` of `@estoc/store`, made once for the program
as the index it holds is. Its index reads the signatures over grants among
the blobs a store holds, by their schema, wherever they sit in the closure of a
record or of what came in: a signature carries its authority in itself, so it
reads the same whoever sent it. Each gives a row, an object of
`mailboxGrantRowSchema`: the identifier of the signer, that of `to`, `at` and
the signature, in the order of those fields; the signature is verified by
the signed identity it carries, as by `noIdentityVersions`. One that does not
verify, or that is over an object that does not read as a grant, gives no row,
since anyone can send a bundle to a mailbox. The scan still fails when the store
fails to give a blob, so a later scan of the index reads it again. The first
scan reads every blob the store holds, attachments as well, and a later one
reads only those put since. `grantsFrom` takes two identifiers and the
`SeenIdentityVersions` of a reader, and gives the grants of the first to the
second that they honor, in the order of the series, each with the signature over it
and the signed identity it is to. `grantFrom` gives the last of those, the latest
grant, or `undefined` when there is none.

The `SeenIdentityVersions` of a reader are the `People` of the signed
identities its store holds, as in `@estoc/identity`. `seen` reads them by
their schema, wherever they sit in the closure of a record or of what came
in, and is made once for the program too.

A root removes an agent by signing an identity version that does not list it,
as in `@estoc/identity`. `asTakenIn` of the reader's people honors a grant as
the store took it in: one the agent signed is honored when it came in before
the store held that identity version, and is not when it came in after, whatever
identity version it carries and whatever `at` it writes:

- `grantFrom` gives the latest grant honored so, which may be one the
  removed agent signed before, or `undefined` when there is none.
- To take messages at a mailbox that no honored grant names, the signer has a key
  the current identity version lists sign a grant of it again, and sends it to
  the one it is to. The signature carries the new identity version, so that
  reader sees the removal and the new grant together.
- A reader holds only the identity versions it has seen, so what a key signs
  is honored until the reader sees the identity version that removes it.
- A grant that came in after the removal is not honored once a later identity
  version lists the agent again either: it is honored by what the store held
  when it took the grant in, so reading the store again gives the same.
- A crisis cuts every grant by an identity version before it, whenever it came
  in.

## Transports

A transport is a plugin:

```ts
interface Transport {
  readonly schema: Schema<Json>;
  deliver(mailbox: JsonObject, ciphertext: Uint8Array): Promise<void>;
}
```

`deliver` takes the data of a mailbox written to `schema` and the
ciphertext, and resolves once it is handed on. When it cannot be, it
rejects with an `UndeliveredMessage` of the kind that it can tell from what
turned it back. How the receiver gets them, such as listening for
requests or fetching from a mailbox service, is the transport's own. Its
receiving side gives a `Pickup` for `Inbox.collect`, or hands ciphertexts
one at a time to `Inbox.receive`, or to `MailboxKey.open` without a store.
This package ships one transport, over HTTP, with no receiving side; its
tests also run on one in memory, whose queues give a pickup.

### HTTP

```ts
import { httpTransport } from "@estoc/mailbox/http";

const mailbox = await mailboxFrom(handedOut, { transports: [httpTransport] });
```

```
HTTP mailbox  {"key": <x25519 public key>, "url": <URL>}
```

The schema is titled `HTTP mailbox`, and takes any string as the url. The
transport posts only to a url that starts with `https://`, or with
`http://` to the receiver's own machine: `localhost`, `127.0.0.1` or
`[::1]`, with or without a port. A ciphertext cannot be read on the way,
but over plain http whoever is on the way sees when messages arrive and how
large they are, and can hold them back unnoticed. On one machine, as in
development or for a daemon beside the sender, no one is on the way.

`deliver` posts the ciphertext to the url as `application/octet-stream`.
No cookies or other credentials and no referrer go with the request, and
nothing is sent again.

- A mailbox at any other url rejects as `gone`, and nothing is posted.
- A 2xx response means it was handed on.
- 404 and 410 reject as `gone`, 408, 429 and 5xx as `later`, and any other
  response as `refused`.
- No response rejects as `later`, and so does a redirect: it is not
  followed, since it would take the bytes to a url the mailbox does not
  name, and a browser does not tell it from no response.

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
