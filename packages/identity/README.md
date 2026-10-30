# @estoc/identity

Someone who signs, as others see them: an identity, the key that stands
behind it, its root, and the keys that sign for it, the root itself or the
agents it lists. A key signs the links of objects of `@estoc/object`. The
keys, the identity, the root's signature over the identity and each
signature are written as objects, which another object names by its link.

```
Key                 an Object written to the key schema of its scheme, with the field
                    "publicKey": <hex>
Identity            an Object written to the Identity schema, with the field
                    "root": <the Key's link>
Delegated Identity  an Object written to the Delegated Identity schema, with the fields
                    "root": <the Key's link>, "agents": [<a Key's link>, …], "at": <Unix ms>
Signed identity     an Object written to the signed identity schema, with the fields
                    "identity": <the identity's link>, "signature": <hex>
Signature           an Object written to the signature schema, with the fields
                    "signedIdentity": <the Signed identity's link>, "object": <the Object's link>, "signature": <hex>
```

The bytes of a Signature are read as the schema of its identity says: an
Identity's are its root's signature, a Delegated Identity's the index of
the agent that signed and that agent's signature.

`loadIdentity` compiles every schema here with the validator the
application picks, and gives what reads and writes the objects of each,
side by side: `keys`, `identities`, `delegatedIdentities`,
`signedIdentities`, `signatures` and `versions`, with `publish` and
`delegate`, which write an identity and have its root sign it. The code is
laid out as the objects are. Each schema has a file of its own, an
interface and the schemas that name it share a directory, `src/key/` and
`src/identity/`, with the interface in `interface.ts`, and one file imports
another where an object of the one links to an object of the other.

## Schemes

A scheme is how a key signs: a curve, how the text it signs is framed
before the curve signs it, and the schema its keys are written to. A key
kept in a chain wallet signs only in that chain's off-chain message
framing, so the framing belongs to the key, and a verifier does not accept
a framing its holder did not choose.

Each scheme is a `Scheme` value in a file of its own under `src/key/`:

- `ed25519`: the text itself, as a software key or a Solana wallet's plain
  `signMessage` signs it.
- `eip191`: an Ethereum `personal_sign` message, by a secp256k1 key in its
  compressed form.
- `solanaOffchain`: a Solana off-chain message, version 1, naming the key
  as its one signer, which Ledger's Solana app signs from 1.14.

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
second. So a signature a root makes for an identity never stands it behind
another identity, even when the object signed is a Delegated Identity of
that root listing someone else. The second text names the Signed identity,
not only the identity: the Signed identity is the identity as its root
publishes it, and a signature is made for what the root published, as it
is. Everything in a Signature but its signature is signed, so one signature
is one Signature. And a root lists an agent without the agent's leave, so a
signature an agent made for one identity would otherwise also verify for
another that lists it.

The keys work without objects. A `Key` is a scheme and a public key,
`verify` checks a signature by one over the text for a digest, and
`sameKey` holds when both the scheme and the public key bytes are the
same, so one public key in two schemes is two keys. The scheme is the same
when it is the same value, so a program holds one copy of this package. A
`Key` carries its scheme as that value, so it is not data to clone or send;
what goes between programs is the key's object. A `Signer` is the private side of a key, as the
capability to sign with it: a wallet stands behind one the same way
`SoftwareSigner` does over a key in memory, which is why signing is
asynchronous.

## Keys

Each scheme writes its keys to a schema of its own, its `keySchema`, and
the schema a key's object is written to is its scheme. The schema holds the
public key, in lowercase hex at its scheme's length, and no other field, so
each key has one object and one link. The schemas of `ed25519` and
`solana-offchain` take public keys of the same shape and differ only in
their titles, which name the schemes: one public key in the two schemes is
two objects, with two links, as it is two keys.

Each key schema names what its objects read as, the Key interface, by
`"x-implements": {"$link": <link>}`, the link of `keyInterface`, whose
bytes are the UTF-8 text `Key`. Whatever the scheme, a key reads as a
`Key`, and the schemas say so in the same way.

A scheme added later comes with a schema of its own, so keys already
written keep their links. A program reads keys written to the key schemas
it knows, as it says which schemas it reads, and refuses one written to any
other, as it would a key in a scheme it does not know.

`keys` reads keys through an `Implementations` of `@estoc/object`, with
one implementation for each scheme. `keys.check` is the
judgment of a key: it takes a key's object and gives the key, in the scheme
of the schema the object is written to. `keys.read` does the same from the
link of the object and a `Reader`, and picks the schema to read the object
with by `schemaOf`. `keys.encode` writes a key as its object, and refuses a
public key that its scheme's schema does not take, and a scheme that is not
one of those `loadIdentity` compiles. A scheme added later is one more file
under `src/key/` and one more of those.

## Identities

An identity is written to one of two schemas, whatever the scheme of its
root, and names its root by the link of the root's object. Both schemas
name the Identity interface in `x-implements`, the link of
`identityInterface`, whose bytes are the UTF-8 text `Identity`, as the key
schemas name the Key interface. Whichever schema it is written to, an
identity reads as an `IdentityObject`, with its root as `root`, and that is
all a reader that does not sign needs. Someone is their root: two
identities are of the same someone when the links of their roots are the
same, so a wallet's Identity and its Delegated Identities are all the
wallet. An object that names someone names their root by that link, while
a signature names a signed identity of the identity it is made for.

- An Identity, written to `identitySchema`, holds its root and nothing
  else, so each key has one, with one link: the identity of a key on its
  own. Its root alone signs for it. A wallet, a service or a device that
  signs for itself uses one.
- A Delegated Identity, written to `delegatedIdentitySchema`, holds its
  root and its agents, the keys the root lists to sign for it, and reads as
  a `DelegatedIdentityObject` with `agents` in the order the root lists
  them. A signature for it names the agent that signed by its index in that
  order, one byte, so it lists at most 256 agents, and each of them once,
  or one signature would verify under two indexes. An agent need not sign
  in its root's scheme, as a browser key can sign for a wallet. The root
  signs for it only if it lists itself; with no agents no one does. It
  holds `at` too, when its root signs it, in milliseconds since the Unix
  epoch. Each one a root signs is a version, and of a root's versions the
  current one is that with the greatest `at`, and of those with the same
  `at`, that whose signed identity has the greater link.

Each identity schema has an implementation of the Identity interface,
which reads its objects with the keys they name and says what a signature
asks of it: which of its keys made a signature, how a signer signs for it,
and whether a key signs for it. `identities` is the implementation of
`identitySchema`, and `identities.encode` writes the Identity whose root
is a key; `delegatedIdentities` is that of `delegatedIdentitySchema`, and
`delegatedIdentities.encode` writes the Delegated Identity of a root, its
agents and its `at`. An identity stands for someone only as its root
signed it, so it is read only as the identity of a signed identity.
Reading an identity takes the blobs of its object and of its keys; an
identity carries them as `blobs`, with those of the schemas they are
written to and of the interfaces those name, each once, so where an
identity goes, as into a store or a bundle, `...identity.blobs` goes along
and leads to nothing it does not carry.

## Signed identities

A signed identity is an identity as its root publishes it, written to
`signedIdentitySchema`: it names the identity by its link and holds the
root's signature over the first text for that link, whichever schema the
identity is written to. Signing is taken to be deterministic, so an
identity has one signed identity. A signature names who makes it by the
link of a signed identity, what the root published as it is, so reading a
signature reads that the root stands behind the identity. Two signers are
the same someone when the roots of their identities are, whichever signed
identities they sign by.

`publish` takes the root's `Signer`, writes its Identity, has the root
sign it, and gives the signed identity: what a wallet confirms once, when
the identity is made. `delegate` takes the root's
`Signer` and the agents' keys, and does the same with the Delegated
Identity that lists them, at `at`, now unless it is given. That is when
the root signs, by its clock: where a version signed by a clock that is
off falls among the others is the root's to answer for, as anything else
it does by that clock. Both write the identity before the root signs, so
a signer is not asked to sign an identity that would not read, such as one
that lists an agent twice. `signedIdentities.read` takes the link of a
signed identity and a `Reader`, reads its identity through an
`Implementations` of the identity schemas, which picks the schema to read
the identity's object with by `schemaOf`, and refuses a signature that the
identity's root did not make. A signed identity carries as `blobs` its
object and its schema with the identity's `blobs`.

A signature is made by a signed identity, so `signedIdentities` asks the
schema of the identity what the signature needs of it, and `signatures`
knows signed identities and no identity schema.

## Versions

A root removes an agent by signing a version that does not list it. A
reader that has seen that version no longer counts the agent's
signatures, whichever version they carry; what it accepted before stays
accepted. A reader knows the versions it has seen, and nothing tells it
of the others.

`versions.of` gives the version a signed identity is, as a row: its root,
its `at` and its link, and undefined for an Identity, which has no
versions. An application keeps the rows of the versions it sees in an
index of its own, such as one of `@estoc/store`, from the signed
identities its own objects lead to. In the order of their keys, a root's
rows end with its current version. `versions.known` takes those rows and
a `Reader`, and gives `Versions`, whose `current` gives the current
version of a signed identity's identity. For a Delegated Identity that is
the later of the one given and the signed identity of its root's last row,
read from the reader and refused unless it is a version of a Delegated
Identity; an Identity is its own. `noVersions` is a reader that knows
none, for which the current version is the one given.

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
is the judgment of a signature: it takes the signature as an object of
`signatures.schema`, a `Reader` and `Versions`, reads its signed identity
from the reader with `signedIdentities.read`, and verifies the signature's
bytes by the key the identity's schema reads from them, over the text for
the object by that signed identity; `signatures.read` does the same from
the link of the signature. It judges the current version as well, as
`current` of the `Versions` gives it, and refuses a key that does not sign
for it: for a Delegated Identity, a key that is not an agent of the later
of the one the signature carries and the latest the reader knows. The one
the signature carries counts, as a device a wallet has just listed signs
by a version the reader has not seen yet. A root's signature through its
Identity counts whatever the versions. The `Versions` are not optional,
so a reader that keeps no versions says so with `noVersions`, and judges
by the version a signature carries alone. So verifying a signature takes the blobs of its signed identity,
but not that of the object signed, since the digest it signs is in the
link. It gives the signature's object with the signed identity it read as
`signedIdentity`, the key that signed as `key`, the link of what it is over
as `object`, and the signature as bytes. Reading a signature with
`decodeObject` and the signature schema alone, as a viewer of arbitrary
objects would, reads its fields without verifying it.

Signing goes through an actor. `signatures.actor` takes a `Signer` and a
signed identity whose identity the signer's key signs for, the root of an
Identity or an agent of a Delegated Identity, gives an `Actor` for it, and
refuses any other signer. So a wallet that lists a key on a device as an
agent does not confirm what the device signs for it. `actor.sign` signs the link of an object, so it takes anything that has
one, and gives a signature whose `signedIdentity` is
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

const { signatures, publish } = await loadIdentity(defaultValidator);
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

Finding the signatures over an object takes an index by the link they
name, so hand an object over together with its signatures.
