# @estoc/identity

Someone who signs, as others see them: an identity, the key that stands
behind it, its root, and the keys that sign for it, the root itself or the
agents it lists. A key signs the links of objects of `@estoc/object`. The
keys, the identity, the root's signature over the identity and each
signature are written as objects, which another object names by its link.

```
Scheme              an Object written to the scheme schema, with the fields
                    "name": <the scheme's name>, "publicKeyLength": <bytes>
Key                 an Object written to its Scheme, with the field
                    "publicKey": <hex>
Identity            an Object written to the Identity schema, with the fields
                    "root": <the Key's link>, "at": <Unix ms>
Delegated Identity  an Object written to the Delegated Identity schema, with the fields
                    "root": <the Key's link>, "agents": [<a Key's link>, …], "at": <Unix ms>
Signed identity     an Object written to the signed identity schema, with the fields
                    "identity": <the identity's link>, "signature": <hex>
Signature           an Object written to the signature schema, with the fields
                    "signedIdentity": <the Signed identity's link>, "object": <the Object's link>, "signature": <hex>
Secret Key          an Object written to the Secret Key schema, with the fields
                    "key": <the Key's link>, "secret": <hex>
Wallet Key          an Object written to the Wallet Key schema, with the field
                    "key": <the Key's link>
```

The bytes of a Signature are read as the schema of its identity says: an
Identity's are its root's signature, a Delegated Identity's the index of
the agent that signed and that agent's signature.

`loadIdentity` compiles every schema here with the validator the
application picks, writes the object of each scheme it picks, and gives
what reads and writes the objects of each,
side by side: `keys`, `identities`, `delegatedIdentities`,
`signedIdentities`, `signatures`, `versions`, `secretKeys` and
`walletKeys`, with `publish` and `delegate`, which write an identity and
have its root sign it. The code is
laid out as the objects are. Each schema has a file of its own, an
interface and the schemas read as it share a directory, `src/key/` and
`src/identity/`, with the interface in `interface.ts`, and one file imports
another where an object of the one links to an object of the other.

## Schemes

A scheme is how a key signs: how the text it signs is framed, the code
that verifies a signature over it, and the object its keys are written to.
A key kept in a chain wallet signs only in that chain's off-chain message
framing, so the framing belongs to the key, and a verifier does not accept
a framing its holder did not choose.

A scheme is a plugin, a `Scheme` value: `name` and `publicKeyLength`, the
data of its object, and `verify`, which says whether a signature is a
public key's over a text. The application picks the schemes it reads keys
in, `loadIdentity(validator, schemes)`, so which keys it accepts is its own
to say, and no registry holds them. Two schemes with one object are
refused. This package keeps what is the same in every scheme: the signing
text, picking a scheme by the link of its object, and the rules of
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
its object, so a plugin with a bug wrongly accepts only signatures by keys
in its scheme, those of the identities whose root or agent is in it. That
does not hold against code meant to harm, which runs in the same
JavaScript realm as the application. A program does not fetch the verifier
of a scheme it has not seen by its link: the link proves the bytes, not
that the verifier is right, and whoever wrote the scheme's object would
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
signature for an identity, a root's for its Identity too, is over the
second. So a signature a root makes for an identity does not stand it
behind another identity, even when the object signed is a Delegated
Identity of that root listing someone else. The second text names the
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

Each scheme has an object, written to `schemeSchema`, that holds its name
and how many bytes its public keys are, and that object is the schema its
keys are written to:

```
key                 {"$schema": {"$link": <ed25519>}, "publicKey": "…"}
ed25519             {"$schema": {"$link": <the scheme schema>}, "name": "ed25519", "publicKeyLength": 32}
the scheme schema   {"$schema": {"$link": <the root of JSON Schema>}, "document": {…}}
```

Each line is the type of the one above it. The scheme schema is a JSON
Schema schema, and the objects of the schemes are the schemas of a language
of their own, which `schemeValidator` reads. It checks a key without a JSON
Schema validator: a key holds its public key, in lowercase hex at its
scheme's length, and no other field, so each key has one object and one
link, and no scheme writes its keys another way. The objects of `ed25519`
and `solana-offchain` differ only in their names: one public key in the two
schemes is two objects, with two links, as it is two keys. A scheme's
object carries as its `blobs` itself, the scheme schema and the root of
JSON Schema.

That an object is a scheme is its type, not a mark in a document. What a
program reads a scheme's keys as is still the program's to say: another
program could read an `ed25519` key as a Solana address.

A scheme added later comes with an object of its own, so keys already
written keep their links. A program reads keys written to the objects of
the schemes it supports, as it says which schemas it reads, and refuses one
written to any other, as it would a key in a scheme it does not support.
Verifying is code, which no object holds, so a program refuses a scheme it
has no verifier for whatever its object says.

`keys` reads keys through an `Implementations` of `@estoc/object`, with
one implementation for each scheme. `keys.check` is the verifier of a key:
it takes a key's object and gives the key, in the scheme of the schema the
object is written to. `keys.read` does the same from the
link of the object and a `Reader`, and picks the schema to read the object
with by `schemaOf`. `keys.encode` writes a key as its object, and refuses a
public key that its scheme's object does not take, and a scheme that is not
one of those `loadIdentity` writes an object for. A scheme added later is one more
plugin an application gives `loadIdentity`.

## Identities

An identity is written to one of two schemas, whatever the scheme of its
root, and names its root by the link of the root's object. The two differ
in shape and share no template, so they are JSON Schema schemas, and
`signedIdentities` is what reads both as identities. Whichever schema it is
written to, an identity reads as an `IdentityObject`, with its root as `root`, and that is
all a reader that does not sign needs. Someone who signs is a person by
their root, a wallet as much as a device or a service: two identities are
of the same person when the links of their roots are the same, so a
wallet's Identity and its Delegated Identities are all the wallet. An
object that names someone names their root by that link, while a
signature names a signed identity of the identity it is made for.

- An Identity, written to `identitySchema`, holds its root and `at`: the
  identity of a key on its own. Its root alone signs for it. A wallet, a
  service or a device that signs for itself uses one.
- A Delegated Identity, written to `delegatedIdentitySchema`, holds its
  root and its agents, the keys the root lists to sign for it, and reads as
  a `DelegatedIdentityObject` with `agents` in the order the root lists
  them. A signature for it names the agent that signed by its index in that
  order, one byte, so it lists at most 256 agents, and each of them once,
  or one signature would verify under two indexes. An agent need not sign
  in its root's scheme, as a browser key can sign for a wallet. The root
  signs for it only if it lists itself; with no agents no one does. It
  holds `at` too.

`at` is when the root signs an identity, in milliseconds since the Unix
epoch. Each identity a root signs is a version, whichever schema it is
written to, and of a root's versions the current one is that with the
greatest `at`, and of those with the same `at`, that whose signed identity
has the greater link. The current version says who signs for the root, the
root itself among them: once a root lists agents in a Delegated Identity,
it signs for itself only where that version lists it as well, and an
Identity it signs after that takes every agent out.

Each identity schema has an implementation of the Identity interface,
which reads its objects with the keys they name and says what a signature
asks of it: which of its keys made a signature, how a signer signs for it,
and whether a key signs for it. An identity carries as `implementation`
the implementation that read or wrote it, so these are asked of the
identity in hand: `hasSigner(identity, key)` says whether `key` signs for
it. `identities` is the implementation of
`identitySchema`, and `identities.encode` writes the Identity whose root
is a key, at its `at`; `delegatedIdentities` is that of `delegatedIdentitySchema`, and
`delegatedIdentities.encode` writes the Delegated Identity of a root, its
agents and its `at`. An identity stands for someone only as its root
signed it: `identities.read` and `delegatedIdentities.read` read an
identity's object with the keys it names and do not authenticate it, and
`signedIdentities.read` verifies that its root signed it. Reading an
identity takes the blobs of its object and of its keys; an identity
carries them as `blobs`, with the blobs of the schemas they are written
to, each once. That is the identity's closure, so
where an identity goes, as into a store or a bundle, `...identity.blobs`
goes along and carries all it links to.

## Signed identities

A signed identity is an identity as its root publishes it, written to
`signedIdentitySchema`: it names the identity by its link and holds the
root's signature over the first text for that link, whichever schema the
identity is written to. A root can sign one identity more than once, and
where its signer signs with randomness, as a passkey does, each signed
identity has a link of its own. A signature names who makes it by the
link of a signed identity, what the root published as it is, so reading a
signature reads that the root stands behind the identity. Two signers are
the same someone when the roots of their identities are, whichever signed
identities they sign by.

`publish` takes the root's `Signer`, writes its Identity at `at`, now
unless it is given, has the root sign it, and gives the signed identity.
`delegate` takes the root's `Signer` and the agents' keys, and does the
same with the Delegated Identity that lists them. Either `at` is when the
root signs, by its clock: where a version signed by a clock that is off
falls among the others is the root's to answer for, as anything else it
does by that clock. Both write the identity before the root signs, so
a signer is not asked to sign an identity that would not read, such as one
that lists an agent twice. `signedIdentities.read` takes the link of a
signed identity and a `Reader`, reads its identity through an
`Implementations` of the identity schemas, which picks the schema to read
the identity's object with by `schemaOf`, and refuses a signature that the
identity's root did not make. A signed identity carries as `blobs` its
object and its schema's blobs with the identity's `blobs`.

The implementation of an identity's schema is picked once, as
`signedIdentities.read` reads it, and the identity carries it. So
`signatures` asks the identity what a signature needs of it, and depends
on signed identities and on no identity schema.

## Versions

A root removes an agent by signing a version that does not list it, and
every agent by signing an Identity. A reader that has seen that version no
longer counts the agent's signatures, whichever version they carry; what
it accepted before stays accepted. A reader holds only the versions it has
seen, and nothing tells it of the others.

`versions.versionOf` gives the version a signed identity is, as a row: its
root, its `at` and its link. In the order of their keys, a root's rows end
with its current version.

`versions.selection` is the `SelectionBySchema` of signed identities, each
read as its row. A signed identity carries its authority in its root's
signature, so it reads the same however it arrived, and an application keeps
the rows of every one it holds in an index of its own, such as
`indexOverBlobs` of `@estoc/store`. A stranger can add no version of a root
that the root did not sign, and an older version leaves the current one as it
is. Anyone can send a signed identity, so one that its root did not sign, or
that does not read, such as one whose root has a scheme the application does
not accept, gives `undefined` and throws nothing. A reader that throws or
gives no blob for what the signed identity names leaves it out the same way,
so what reads with a reader that can fail has to notice that itself, as a scan
of `@estoc/store` does.

`versions.people` takes those rows and a `Reader`, and gives the `People` of
the versions the reader has seen, which are `Versions` too: their `current`
gives the current version of a signed identity's identity, the later of the
one given and the signed identity of its root's last row, read from the
reader. `noVersions` is a reader that has seen no versions, so the current
version is the one given and a signature is verified by the version it
carries alone.

## People

A person is a root and the versions of its identity that a reader has
seen. `people.personOf` takes a signed identity in hand, such as that
of a signature just read, and gives the `Person` of its root:

- `root`, the root's key, as the signed identity holds it.
- `versions()`, the versions of the root's identity the reader has seen, with
  the one in hand, each once and in the order of their rows. Each is read
  from the reader, signed by the root.
- `current()`, the last of them, which says who signs for the person now.
- `hasSigned(signature)`, whether a signature already read was made for an
  identity of the root.

The versions are those the reader has seen, in the order of the root's
clock, and none of them names the one before, so one between two of them
may be missing, and `current()` is the latest the reader has seen, not the
latest the root signed. `current` of `People` is that of the person of the
signed identity it is given.

A person is worked out from the rows when they are read and is not
written: their root names them, but what they hold changes as the reader
sees more. Two people are one when the links of their roots are. Two taken
from different signed identities of a root may differ in `versions()`,
since each holds the one it was taken from, but their `current()` differs
only when the one in hand is later than any the reader has seen, which a
signature carrying it counts as well.

A person reads no signatures. What a signature is read from, and whether
it is verified against the versions a store holds or by `noVersions` alone,
are for the caller to choose, so `hasSigned` takes one already read. With
`@estoc/store`, an application gives the index and `versions.people`
reads its rows:

```ts
const seen = indexOverBlobs(versions.selection, (version) => [version]);
const people = await view(store, { index: seen, read: (rows, reader) => versions.people(rows, reader) });
const signature = await signatures.read(link, store, people);
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
them reads: in each scheme here, one signature of 64 bytes. Signing with a
threshold of keys would be another identity schema; a scheme whose
signature holds more, such as a passkey's authenticator data, lays it out
in its own bytes. Either way the signature schema, and what reads
signatures by it, stay as they are.

`signatures` holds the signature schema and `actor`. `signatures.verify`
is the verifier of a signature: it takes the signature as an object of
`signatures.schema`, a `Reader` and `Versions`, reads its signed identity
from the reader with `signedIdentities.read`, and verifies the signature's
bytes by the key the identity's schema reads from them, over the text for
the object by that signed identity; `signatures.read` does the same from
the link of the signature. It also checks the key against the current
version, as `current` of the `Versions` gives it, the later of the one the
signature carries and the latest the reader has seen, and refuses a key
that does not sign for it: the root of an Identity, or an agent of a
Delegated Identity. The one the signature carries counts, as a device a
wallet has just listed signs by a version the reader has not seen yet. The
`Versions` are not optional, so a reader that keeps no versions says so
with `noVersions`, and a signature is then verified by the version it
carries alone. Verifying a signature takes the blobs of its signed
identity, but not that of the object signed, since the digest it signs is
in the link. It gives the signature's object with the signed identity it read as
`signedIdentity`, the key that signed as `key`, the link of what it is over
as `object`, and the signature as bytes. Reading a signature with
`decodeObject` and the signature schema alone, as a viewer of arbitrary
objects would, reads its fields without verifying it.

Signing goes through an actor. `signatures.actor` takes a `Signer` and a
signed identity whose identity the signer's key signs for, the root of an
Identity or an agent of a Delegated Identity, gives an `Actor` for it, and
refuses any other signer. So a wallet that lists a key on a device as an
agent does not confirm what the device signs for it. `actor.sign` signs the
link of an object, so it takes anything that has one, and gives a signature
whose `signedIdentity` is
`actor.signedIdentity`, the signed identity the actor was made for, whose
`blobs` go along with the signature. It verifies the signature after the
signer signs, so a signer whose signature does not verify is refused.

A server that handed out a nonce can build the login object of the example
in `@estoc/object` itself, and take back only the signature, with the
signed identity's blobs:

```ts
import { ed25519, loadIdentity, noVersions, SoftwareSigner } from "@estoc/identity";
import { decodeObject, encodeObject, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";

const { signatures, publish } = await loadIdentity(defaultValidator, [ed25519]);
const signer = SoftwareSigner.fromSecretKey(ed25519, secretKey);
const actor = signatures.actor(signer, await publish(signer));
const signature = await actor.sign(object);
// The client sends signature.bytes and signature.signedIdentity.blobs.

const expected = encodeObject(login, { audience: "https://app.estoc.dev", nonce: "6f1c0a9e" });
const signed = decodeObject(signatureBytes, signatures.schema);
const blobs = new Map(identityBlobs.map((bytes) => [linkOf(bytes), bytes]));
const read = await signatures.verify(signed, blobs, noVersions);
const user = read.object === expected.link ? read.signedIdentity.identity : undefined;
```

`signatures.selectionOver(schema)` is a `SelectionBySchema` of the
signature schema, as `@estoc/object` has selections. It takes the
signatures over objects of `schema`, each as a `SignatureOver`: the
signature with the object it signs, read with `schema`. A signature over
an object of another schema is left out. It does not verify the
signatures it takes, since what a selection takes depends on the record
and its closure alone, and whether a signature counts depends on the
versions a reader has seen. An index whose rows need a signature verified
verifies it in `rows`, by `noVersions`, and leaves whether that version
still counts to what reads the rows. Here the notes each root has signed:

```ts
const signedNotes = indexOver(signatures.selectionOver(noteSchema), async function* ({ signature, object }, reader) {
  const { signedIdentity } = await signatures.verify(signature, reader, noVersions);
  yield [signedIdentity.identity.root.link, object.link];
});
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
`blobs` its closure, its object, its key's and the blobs of the schemas
they are written to, so one write puts it in an empty private store:

```ts
const secretKey = secretKeys.encode(ed25519, crypto.getRandomValues(new Uint8Array(32)));
await privateStore.write({ records: [secretKey], blobs: secretKey.blobs });
const { signer } = await secretKeys.read(secretKey.link, privateStore);
```
