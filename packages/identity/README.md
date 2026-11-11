# @estoc/identity

Someone who signs, as others see them: an identity, the key that stands
behind it, its root, and the keys that sign for it, the root itself and the
agents it lists. A key signs the links of objects of `@estoc/object`. The
keys, the identity, the root's signature over the identity and each
signature are written as objects, which another object names by its link.

```
Key                 an Object written to the schema of its scheme, with the field
                    "publicKey": <hex>
Identity            an Object written to the Identity schema, with the fields
                    "prior": <a Signed identity's link>, "root": <the Key's link>,
                    "agents": [<a Key's link>, …], "crisis": true, "at": <Unix ms>,
                    and "prior" and "crisis" only where they hold
Signed identity     an Object written to the signed identity schema, with the fields
                    "identity": <the identity's link>, "signature": <hex>
Signature           an Object written to the signature schema, with the fields
                    "signedIdentity": <the Signed identity's link>, "object": <the Object's link>, "signature": <hex>
Secret Key          an Object written to the Secret Key schema, with the fields
                    "key": <the Key's link>, "secret": <hex>
Wallet Key          an Object written to the Wallet Key schema, with the field
                    "key": <the Key's link>
```

The bytes of a Signature are read as the Identity schema says: the index of
the key that signed, the root first and its agents after it, and that key's
signature.

The schemas here are written in the language of `@estoc/schema`.
`loadIdentity` writes the schema of each scheme the application picks, and
gives what reads and writes the objects of each schema, side by side:
`keys`, `identities`, `signedIdentities`, `signatures`, `identityVersions`,
`secretKeys` and `walletKeys`, with `publish`, which writes an identity and
has its root sign it. The code is laid out as the objects are. Each schema
has a file of its own, the key interface and the schemes read as it share
`src/key/`, with the interface in `interface.ts`, and one file imports
another where an object of the one links to an object of the other.

## Schemes

A scheme is how a key signs: how the text it signs is framed, the code
that verifies a signature over it, and the schema its keys are written to.
A key kept in a chain wallet signs only in that chain's off-chain message
framing, so the framing belongs to the key, and a verifier does not accept
a framing its holder did not choose.

A scheme is a plugin, a `Scheme` value: `name`, the title of its schema,
`publicKeyLength`, and `verify`, which says whether a signature is a
public key's over a text. The application picks the schemes it reads keys
in, `loadIdentity(schemes)`, so which keys it accepts is its own
to say, and no registry holds them. Two schemes with one name are
refused. This package keeps what is the same in every scheme: the signing
text, picking a scheme by the link of its schema, and the rules of
identities and signatures. A scheme only answers whether a key's signature
over a text holds. A `Signer` is not part of it, and a plugin can give one
of its own, as a wallet or a passkey would.

`Scheme` documents the rules a scheme keeps:

- One signing act has one valid encoding. Signatures are stored and hashed
  as bytes, and a second encoding of the same signature would give the
  same act a second link.
- `name` is not that of another scheme.
- The text is framed as it is, not rewritten.

`checkScheme` of `@estoc/identity/conformance` checks a scheme against
them, for a plugin to run in its tests. It takes the scheme, a signer whose
key is in it and a function that gives another encoding of a signature,
and gives the rules the scheme breaks: what the signer signs verifies, and
not for another digest or another signed identity, and the other encoding
does not verify.

Most schemes are a curve signing the text in a framing, and
`curveScheme(name, curve, message)` writes one as a `CurveScheme`, whose
signatures are 64 bytes and which `SoftwareSigner` signs in. The curves
here, `ed25519Curve` and `secp256k1Curve`, verify strictly, so that each
signature has one encoding. `ed25519Curve` signs the framed text whole;
`secp256k1Curve` signs a 32-byte hash, as ECDSA does, so a scheme on it
hashes the whole framed text, as `eip191` does with Keccak-256. Each scheme here is a `curveScheme` in a file
of its own under `src/key/`, written with the public API alone:

- `ed25519`: the text itself, as a software key or a Solana wallet's plain
  `signMessage` signs it.
- `eip191`: an Ethereum `personal_sign` message, by a secp256k1 key in its
  compressed form.
- `solanaOffchain`: a Solana off-chain message, version 1, naming the key
  as its one signer, which Ledger's Solana app signs from 1.14.

A plugin depends on `@estoc/identity` as a peer dependency, so a program
holds one copy of it, which `isSameKey` and `keys.encode` need. A scheme is picked by the link of
its schema, so a plugin with a bug wrongly accepts only signatures by keys
in its scheme, those of the identities whose root or agent is in it. That
does not hold against code meant to harm, which runs in the same
JavaScript realm as the application. A program does not fetch the verifier
of a scheme it has not seen by its link: the link proves the bytes, not
that the verifier is right, and whoever wrote the scheme's schema would
have written its verifier too. Trust in the code comes from the
application that picks it.

Every scheme signs the same texts before its framing, `signingText(digest,
signedIdentity?)`. A key signs objects and nothing else, and a login or a
grant is an object too, so no signature can be passed off as another kind.
It is text because wallets show text, and it says what it is so that a
wallet user asked elsewhere to sign it as, say, a login nonce can tell.

```
a root signs an identity:                Estoc Object (sha256:<the identity's digest>)
a key signs an object for an identity:  Estoc Object (sha256:<the object's digest>) by (sha256:<the Signed identity's digest>)
```

The first text is signed only when a root signs an identity, and every
signature for an identity, a root's too, is over the second. So a
signature a root makes for an identity does not stand it behind another
identity, even when the object signed is another identity of that root
listing someone else. The second text names the
Signed identity, not only the identity: the Signed identity is the
identity as its root publishes it, and a signature is made for what the
root published, as it is. Everything in a Signature but its signature is
signed, so one signature is one Signature. And a root lists an agent
without the agent's leave, so a signature an agent made for one identity
would otherwise also verify for another that lists it.

The keys work without objects. A `Key` is a scheme and a public key,
`verify` checks a signature by one over the text for a digest, and
`isSameKey` holds when both the scheme and the public key bytes are the
same, so one public key in two schemes is two keys. The scheme is the same
when it is the same value, so a program holds one copy of this package. A
`Key` carries its scheme as that value, so it is not data to clone or send;
what goes between programs is the key's object. A `Signer` is the private
side of a key, as the capability to sign with it: a wallet stands behind one
the same way `SoftwareSigner` does over a key in memory, which is why
signing is asynchronous.

## Keys

Each scheme has a schema that its keys are written to, with the scheme's
name as its title:

```
key                 {"$schema": {"$link": <ed25519>}, "publicKey": "…"}
ed25519             {"title": "ed25519", "fields": {"publicKey": {"type": "bytes"}}}
```

The second line is the schema of the first. A key holds its public key, in
lowercase hex, and no other field, so each key has one object and one
link, and no scheme writes its keys another way. The schemas of `ed25519`
and `solana-offchain` differ only in their titles: one public key in the
two schemes is two objects, with two links, as it is two keys. A schema
does not say how long its bytes are, so `keys` refuses a public key of
another length than its scheme's.

The scheme of a key is its type, its `$schema`, not a field of its data.
What a program reads a scheme's keys as is still the program's to say:
another program could read an `ed25519` key as a Solana address.

A scheme added later comes with a schema of its own, so keys already
written keep their links. A program reads keys written to the schemas of
the schemes it supports, as it says which schemas it reads, and refuses one
written to any other, as it would a key in a scheme it does not support.
Verifying is code, which no object holds, so a program refuses a scheme it
has no verifier for whatever its schema says.

`keys` reads keys through an `Implementations` of `@estoc/object`, with
one implementation for each scheme. `keys.check` is the verifier of a key:
it takes a key's object and gives the key, in the scheme of the schema the
object is written to. `keys.read` does the same from the
link of the object and a `Reader`, and picks the schema to read the object
with by `schemaOf`. `keys.encode` writes a key as its object, and refuses a
public key of another length than its scheme's, and a scheme that is not
one of those given to `loadIdentity`. A scheme added later is one more
plugin an application gives `loadIdentity`.

## Identities

An identity is written to `identitySchema`, whatever the scheme of its
root, and names its root by the link of the root's object. It reads as an
`IdentityObject`, with its root as `root`, and that is all a reader that
does not sign needs. Someone who signs is a person by their `identifier`,
the link of their root, a wallet as much as a device or a service: two
identities are of the same person when their identifiers are the same, so
every identity a wallet signs is the wallet. An object that names someone
names them by their identifier, while a signature names a signed identity
of the identity it is made for.

An identity holds its root, its agents, which are the keys the root lists
to sign for it, and `at`. It reads with `agents` in the order the root
lists them. The root signs for it, and so do its agents, and an agent need
not sign in its root's scheme, as a browser key can sign for a wallet. A
signature for it names the key that signed by its index, one byte: the
root is 0 and the agents follow, so it lists at most 255 agents, each of
them once and not the root, or one signature would verify under two
indexes. A wallet, a service or a device that signs for itself lists none.

`at` is when the root signs an identity, in milliseconds since the Unix
epoch. Each identity a root signs is an identity version. `prior` names
the signed identity of the identity version it follows, of the same root
and with an earlier `at`, and one without it starts a chain. `crisis`
marks a crisis, below. An identity holds `prior` and `crisis` only where
they hold, so it has one object.

The schema says the fields of an identity and their types. That it lists
each agent once and not its root, lists at most 255, and writes `crisis`
as `true` alone is checked where an identity is read or written, so a
reader that reads one as an object of the schema alone does not check it.

`identities` writes identities. `identities.encode(root, content)` writes
the identity of a root that an `IdentityContent` says: `prior`, the signed
identity it follows, `agents`, `isCrisis` and `at`, now unless it is given.
It refuses agents that list the root or one of them twice, or are more than
255, and a prior of another root or one that is not earlier. An identity
stands for someone only as its root signed it: `identities.read` reads an
identity's object with the keys it names, as following the signed identity
its `prior` names, which the caller reads, and does not authenticate it,
while `signedIdentities.read` verifies that its root signed it.
`hasSigner(identity, key)` says whether `key` signs for an identity. Reading
an identity takes the blobs of its object, of its keys and of the signed
identity it follows; an identity carries them as `blobs`, with the
schemas they are written to, each once. That is the identity's closure,
so where an identity goes, as into a store or a bundle, `...identity.blobs`
goes along and carries all it links to, the identity versions it follows
among them.

## Signed identities

A signed identity is an identity as its root publishes it, written to
`signedIdentitySchema`: it names the identity by its link and holds the
root's signature over the first text for that link, whichever schema the
identity is written to. A root can sign one identity more than once, and
where its signer signs with randomness, as a passkey does, each signed
identity has a link of its own. A signature names who makes it by the
link of a signed identity, what the root published as it is, so reading a
signature reads that the root stands behind the identity. Two signers are
the same someone when the identifiers of their identities are, whichever
signed identities they sign by.

`publish` takes the root's `Signer` and an `IdentityContent`, writes the
identity, at `at`, now unless it is given, has the root sign it, and gives
the signed identity. `at` is when the root signs, by its clock: where an
identity version signed by a clock that is off falls among the others is
the root's to answer for, as anything else it does by that clock. It
writes the identity before the root signs, so a signer is not asked to sign
an identity that would not read, such as one that lists an agent twice.
`signedIdentities.verify` takes the object of a signed identity and a
`Reader`, reads its identity with the keys it names and the signed
identities it follows, each verified, and refuses a signature that the
identity's root did not make. `signedIdentities.read` reads that object
from its link first. A signed identity carries as `blobs` its object and
its schema with the identity's `blobs`.

What a signature asks of an identity, which key made it and how a signer
signs for it, is asked of the identity in hand, so `signatures` depends on
signed identities alone.

## Identity Versions

Each identity version names the one it follows as `prior`, so a root's
identity versions are a chain, and the closure of each holds those it
follows. Two that follow the same one are a fork, and both stay.

A root removes an agent by signing an identity version that does not list
it. A reader that has seen that identity version takes in none of the
agent's signatures after it, whichever identity version they carry; what it
accepted before stays accepted. The agent chooses which identity version
its signature carries, and a signature carries no time: a time in the
signed record is its author's own. So the reader cannot tell when the agent
signed, only when the signature came in. A reader holds only the identity versions it has seen,
and nothing tells it of the others.

A root that no longer relies on what it signed before, as when the store of
an agent leaks, signs a crisis, an identity version that holds `crisis`.
Of a root's identity versions, the latest crisis, by `at` and then by the
link of its signed identity, and the ones that follow it count. The others
do not: those before it, and those on a branch that does not follow it.
With no crisis, all of them count. A signature by an identity version that
does not count is not honored, whoever made it, the root among them,
and whenever the reader took it in. Which records still stand, and what to
sign again, is for each application to say: a crisis rebuilds from the
root and does not undo what was done. Each identity version after a crisis
follows it, so a reader that has seen only a later one has seen the crisis
too.

`identityVersions.identityVersionOf` gives the identity version a signed
identity is, as the data of a row of `identityVersionSchema`: its identifier,
its `at`, its link and, where there is one, its last crisis, the latest crisis
among it and those it follows. Each
identity version is later than the one it follows, so no crisis follows the
latest crisis, and those that count are the ones whose last crisis it is.
`identityVersions.order` names that schema and the fields that order the rows
of an index: the identifier, `at` and then the link, so the rows of one
identifier come together, in the order of their `at`.

`identityVersions.selection` is the `SelectionBySchema` of signed identities,
each read as the data of its row. A signed identity carries its authority in its root's
signature, so it reads the same however it arrived, and an application keeps
the rows of every one it holds in an index of its own, such as
`indexOverBlobs` of `@estoc/store`. A stranger can add no identity version of
someone that their root did not sign, and an older identity version leaves the
current one as it is, unless it is a crisis that the current one does not
follow.

Anyone can send a signed identity, so one whose identity does not read, such
as one whose root has a scheme the application does not accept, or whose root
did not sign it, gives `undefined`. A reader that throws or gives no blob for
what the signed identity names leaves it out the same way, so what reads with a
reader that can fail has to notice that itself, as a scan of `@estoc/store`
does. The object itself is read before any of this: `selection.read` throws as
that of any `SelectionBySchema` does when the reader gives no blob for it, or
when it names the schema and does not fit it. `indexOverBlobs` gives no row for
a blob that does not fit the schema, and a scan still fails when the store does
not give a blob it lists.

`identityVersions.people` takes those rows and the store they are of, a
`StoreReader`, which gives blobs by link and where it took each in, as a
store of `@estoc/store` does. It gives the `People` of the identity versions
the reader has seen. The rows hold those each identity version follows, as
an index over the blobs of a store does.
Their `current` gives the current identity version of the person of a
signed identity: of those the reader has seen and the one given with those it follows,
the latest that counts, read from the reader. They are the reader's
`SeenIdentityVersions` too, which say whether the reader honors a
signature: their `honors` says whether the identity version it carries
counts, and whether the key that made it signs for the current identity
version of whoever made it. That is how a signature that comes in now is honored,
such as a request a service answers, whether or not the store took it in
before.

`asTakenIn` of `People` is the `SeenIdentityVersions` of what the store
holds. It honors a signature as the store took it in:

- By the identity versions the store held when it took the signature in,
  with the one the signature carries and those it follows: its identity
  version counts by them, and its key signs for the current one of them.
  An identity version the store takes in later that does not list the key
  leaves it honored, and one taken in before refuses it, whichever
  identity version it carries.
- By the identity versions the store holds now, as for its identity version
  counting: a crisis cuts it, whenever the store took the crisis in.
- A signature the store does not hold comes in now, and is honored as by
  `honors`, as is one that only a staged batch holds until the batch is
  committed.

The store keeps the order it took blobs in, so reading it again gives the
same. The order is of one store: another device that takes in the same
blobs in another order may honor a signature otherwise.

`noIdentityVersions` is a reader that has seen no identity versions, so it
honors a signature by the identity version it carries and those it follows
alone, of which it is the latest.

## People

A person is an identifier and the identity versions of theirs that a
reader has seen. `people.personOf` takes a signed identity in hand, such as
that of a signature just read, and gives the `Person` of it:

- `identifier`, the identifier of the signed identity's identity.
- `identityVersions()`, the person's identity versions that count, of those
  the reader has seen and the one in hand with those it follows, each once
  and in the order of their rows. Each is read from the reader, signed by
  its root.
- `current()`, the last of them, which says who signs for the person now.
- `hasSigned(signature)`, whether a signature already read was made for an
  identity of the person.

The identity versions are in the order of the root's clock. Each names the
one it follows, so the reader has seen every one before each it has seen,
on that branch. One the root signed later, or one on another branch, may be
missing, and `current()` is the latest that counts of those the reader has
seen, not the latest the root signed. `current` of `People` is that of the
person of the signed identity it is given.

A person is worked out from the rows when they are read and is not
written: their identifier names them, but what they hold changes as the
reader sees more. Two people are one when their identifiers are. Two taken
from different signed identities of someone may differ in `identityVersions()`
and in `current()`: each takes the identity versions the reader has seen with
the one it was taken from and those it follows, and of those the latest
crisis and the ones that follow it count, or all of them when none is a
crisis. A signature that carries the one in hand is honored by the same.

A person reads no signatures. What a signature is read from, and whether
it is verified against the identity versions a store holds or by
`noIdentityVersions` alone, are for the caller to choose, so `hasSigned`
takes one already read. With `@estoc/store`, an application gives the index
and `identityVersions.people` reads its rows:

```ts
const seen = indexOverBlobs(identityVersions.selection, identityVersions.order, (identityVersion) => [identityVersion]);
const people = await view(store, { index: seen, read: (rows, reader) => identityVersions.people(rows, reader) });
const signature = await signatures.read(link, store, people.asTakenIn);
const author = people.personOf(signature.signedIdentity);
```

## Signatures

A signature says one thing: this identity stands behind this object. It
carries no role and no time. Who has to sign, and what makes a login or a
contract hold, is for the application that reads the object, by the schema
it pins; anyone can sign an object, whether the object names them or not.
Each signature is a blob of its own, collected and passed on apart from the
others over the same object.

A signature is itself an object, written to `signatureSchema` whatever the
identity and the key that signs, so a format that holds an object can hold
a signature. It names a signed identity and the object it is over by their
links, and holds the signature as bytes, in lowercase hex, which writes
each byte string one way. The schema of the identity says which key signs
and how the bytes are laid out, and that key's scheme how its signature in
them reads: in each scheme here, one signature of 64 bytes. A scheme whose
signature holds more, such as a passkey's authenticator data, lays it out
in its own bytes, and the signature schema, and what reads signatures by
it, stay as they are.

`signatures` holds the signature schema and `actor`. `signatures.verify`
is the verifier of a signature: it takes the signature as an object of
`signatures.schema`, a `Reader` and `SeenIdentityVersions`, reads its signed
identity from the reader with `signedIdentities.read`, and verifies the
signature's bytes by the key the identity's schema reads from them, over the
text for the object by that signed identity; `signatures.read` does the same
from the link of the signature. It also refuses a signature that the
`SeenIdentityVersions` it is given do not honor. By `honors` of `People`,
that is one whose identity version a crisis cuts, or whose key does not
sign for the current identity version, the latest that counts of those the
reader has seen and the one the signature carries; by `asTakenIn`, the
current identity version is of those the store held when it took the
signature in. The root signs for an identity, and so do its agents. The one the
signature carries counts, as a device a wallet has just listed signs by an
identity version the reader has not seen yet. The `SeenIdentityVersions`
are not optional, so a reader that keeps no identity versions says so with
`noIdentityVersions`, and a signature is then verified by the identity
version it carries alone. Verifying a
signature takes the blobs of its signed identity, but not that of the object
signed, since the digest it signs is in the link. It gives the signature's
object with the signed identity it read as `signedIdentity`, the key that
signed as `key`, the link of what it is over as `object`, and the signature
as bytes. Reading a signature with `decodeObject` and the signature schema
alone, as a viewer of arbitrary objects would, reads its fields without
verifying it.

Signing goes through an actor. `signatures.actor` takes a `Signer` and a
signed identity whose identity the signer's key signs for, its root or one
of its agents, gives an `Actor` for it, and refuses any other signer. So a
wallet that lists a key on a device as an agent does not confirm what the
device signs for it. `actor.sign` signs the
link of an object, so it takes anything that has one, and gives a signature
whose `signedIdentity` is
`actor.signedIdentity`, the signed identity the actor was made for, whose
`blobs` go along with the signature. It verifies the signature after the
signer signs, so a signer whose signature does not verify is refused.

A server that handed out a nonce can build the login object of the example
in `@estoc/object` itself, and take back only the signature, with the
signed identity's blobs:

```ts
import { ed25519, loadIdentity, noIdentityVersions, SoftwareSigner } from "@estoc/identity";
import { decodeObject, encodeObject, linkOf } from "@estoc/object";

const { signatures, publish } = loadIdentity([ed25519]);
const signer = SoftwareSigner.fromSecretKey(ed25519, secretKey);
const actor = signatures.actor(signer, await publish(signer));
const signature = await actor.sign(object);
// The client sends signature.bytes and signature.signedIdentity.blobs.

const expected = encodeObject(login, { audience: "https://app.estoc.dev", nonce: "6f1c0a9e" });
const signed = decodeObject(signatureBytes, signatures.schema);
const blobs = new Map(identityBlobs.map((bytes) => [linkOf(bytes), bytes]));
const read = await signatures.verify(signed, blobs, noIdentityVersions);
const user = read.object === expected.link ? read.signedIdentity.identity : undefined;
```

`signatures.selectionOver(schema)` is a `SelectionBySchema` of the
signature schema, as `@estoc/object` has selections. It takes the
signatures over objects of `schema`, each as a `SignatureOver`: the
signature with the object it signs, read with `schema`. A signature over
an object of another schema is left out. It does not verify the
signatures it takes, since what a selection takes depends on the record
and its closure alone, and whether a signature is honored depends on the
identity versions a reader has seen. An index whose rows need a signature
verified verifies it in `rows`, by `noIdentityVersions`, and leaves whether
it is still honored to what reads the rows, which asks `honors` of a
reader's `SeenIdentityVersions`. Here the notes each person has signed, by
their identifier:

```ts
const signedNoteSchema = schema("Signed note", { signer: link(), note: link() });
const signedNotes = indexOver(
  signatures.selectionOver(noteSchema),
  { schema: signedNoteSchema, by: ["signer"] },
  async function* ({ signature, object }, reader) {
    const { signedIdentity } = await signatures.verify(signature, reader, noIdentityVersions);
    yield { signer: { $link: signedIdentity.identity.identifier }, note: { $link: object.link } };
  },
);
```

Finding the signatures over an object takes an index by the link they
name, so hand an object over together with its signatures.

## Secret Keys and Wallet Keys

Which keys a device signs with is for its private store to say, the
`PrivateStore` of `@estoc/store` that it keeps beside its store. It holds
one of two objects for each such key:

- A Secret Key, written to `secretKeySchema`, holds the key by the link of
  its object, and `secret`, the key's secret as 32 bytes in lowercase hex.
  The device signs with the secret in memory.
- A Wallet Key, written to `walletKeySchema`, holds the key alone. The
  device signs through a wallet, the one whose public key is the key's.

To sign with a key, a device looks for either. With its Secret Key it signs
with a `SoftwareSigner`; with its Wallet Key it connects a wallet and checks
the public key the wallet gives; with neither it does not sign with the
key. A key with no secret is not taken to be a wallet's, since the keys of
others and the agents of other devices have none here either, so the
private store lists just the keys the device signs with. The two are
separate schemas, so a Wallet Key does not read as a Secret Key that lacks
its secret. A Wallet Key holds no secret, and is in the private store
because it means something to that device alone.

A key that signs for every request, such as a service's or an agent's on a
device, has a Secret Key, since nobody is there to confirm on a wallet. A
wallet suits a root, which signs rarely and with someone there: to publish,
or to change its agents. A user with no wallet has a Secret Key for their
root too.

`secretKeys.encode(scheme, secret)` writes the Secret Key of a secret in a
`CurveScheme`; the caller makes the secret. `secretKeys.read` reads one
from its link and a `Reader`, such as a private store, with its key and
`signer`, a `Signer` over the secret. It refuses a Secret Key whose key is
in a scheme no curve signs in, and one whose secret is not that of its key.
`walletKeys.encode(key)` and `walletKeys.read` do the same for a Wallet
Key, which reads with its key alone: connecting the wallet is for the
application, and what signs takes a `Signer` either way. Each carries as
`blobs` its closure, its object, its key's and the schemas they are
written to, so one write puts it in an empty private store:

```ts
const secretKey = secretKeys.encode(ed25519, crypto.getRandomValues(new Uint8Array(32)));
await privateStore.write({ records: [secretKey], blobs: secretKey.blobs });
const { signer } = await secretKeys.read(secretKey.link, privateStore);
```
