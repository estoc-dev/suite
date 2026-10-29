# @estoc/identity

Someone who signs, as others see them: an identity, and the key that signs
for it, its root. A key signs the links of objects of `@estoc/object`. The
key, the identity and the signature are each written as an object, which
another object names by its link.

```
Key        an Object written to the key schema of its scheme, with the field
           "publicKey": <hex>
Identity   an Object written to the identity schema, with the field
           "root": <the Key's link>
Signature  an Object written to the signature schema, with the fields
           "identity": <the Identity's link>, "object": <the Object's link>, "signature": <hex>
```

## Schemes

A scheme is how a key signs: a curve, how the text it signs is framed
before the curve signs it, and the schema its keys are written to. A key
kept in a chain wallet signs only in that chain's off-chain message
framing, so the framing belongs to the key, and a verifier does not accept
a framing its holder did not choose.

- `ed25519`: the text itself, as a software key or a Solana wallet's plain
  `signMessage` signs it.
- `eip191`: an Ethereum `personal_sign` message, by a secp256k1 key in its
  compressed form.
- `solana-offchain`: a Solana off-chain message, version 1, naming the key
  as its one signer, which Ledger's Solana app signs from 1.14.

Every scheme signs the same text for an object's SHA-256 digest before its
framing, `signingText(digest)`: `Estoc Object (sha256:<hex>)`. A key signs
objects and nothing else, and a login or a grant is an object too, so no
signature can be passed off as another kind. It is text because wallets
show text, and it says what it is so that a wallet user asked elsewhere to
sign it as, say, a login nonce can tell.

The keys work without objects. A `Key` is a scheme and a public key,
`verify` checks a signature over a digest by one, and `sameKey` holds when
both the scheme and the public key bytes are the same, so one public key in
two schemes is two keys. A `Signer` is the private side of a key, as the
capability to sign with it: a wallet stands behind one the same way
`SoftwareSigner` does over a key in memory, which is why signing is
asynchronous.

## Keys

Each scheme writes its keys to a schema of its own, in `keySchemas`, and
the schema a key's object is written to is its scheme. The schema holds the
public key, in lowercase hex at its scheme's length, and no other field, so
each key has one object and one link. The schemas of `ed25519` and
`solana-offchain` take public keys of the same shape and differ only in
their titles, which name the schemes: one public key in the two schemes is
two objects, with two links, as it is two keys.

A scheme added later comes with a schema of its own, so keys already
written keep their links. A program reads keys written to the key schemas
it knows, as it says which schemas it reads, and refuses one written to any
other, as it would a key in a scheme it does not know.

`loadKeys` compiles the key schemas with the validator the application
picks, and gives `keys`. `keys.check` is the judgment of a key: it takes a
key's object and gives the key, in the scheme of the schema the object is
written to. `keys.read` does the same from the link of the object and a
`Reader`, and picks the schema to read the object with by `schemaOf`.
`keys.encode` writes a key as its object, and refuses a public key that its
scheme's schema does not take.

## Identities

An identity is written to `identitySchema`, whatever the scheme of its
root, and names its root by the link of the root's object. It holds its
root and nothing else, so each key has one identity, with one link, and
two identities are the same when their links are. An object that names
someone, such as a signature, names their identity, not their key.

`loadIdentities` compiles the identity schema and the key schemas with the
validator the application picks, and gives `identities`, which holds
`keys`. `identities.read` takes the link of an identity and a `Reader`,
reads the identity's object and then its root with `keys.read`, and gives
the identity with its root as `root`. `identities.encode` writes the
identity whose root is a key. Reading an identity takes the blobs of both
objects; an identity carries them as `blobs`, with those of the schemas
they are written to, so where an identity goes, as into a store or a
bundle, `...identity.blobs` goes along.

## Signatures

A signature says one thing: this identity stands behind this object. It
carries no role and no time. Who has to sign, and what makes a login or a
contract hold, is for the application that reads the object, by the schema
it pins; anyone can sign an object, whether the object names them or not.
Each signature is a blob of its own, collected and passed on apart from the
others over the same object.

A signature is itself an object, written to `signatureSchema` whatever the
scheme of the key that signs, so a format that holds an object can hold a
signature. It names its identity and the object it is over by their links,
and holds the signature as bytes, in lowercase hex, which writes each byte
string one way. What the bytes hold is for the key's scheme to say: in
each scheme here, one signature of 64 bytes. A scheme whose signature holds
more, such as a passkey's authenticator data or the shares of a threshold,
lays it out in the bytes its own way, and the signature schema, and what
reads signatures by it, stay as they are.

`loadSignatures` compiles the signature schema, the identity schema and
the key schemas with the validator the application picks, and gives
`signatures`, which holds the signature schema, `identities` and `sign`.
`signatures.verify` is the judgment of a signature: it takes the signature
as an object of `signatures.schema` and a `Reader`, reads its identity from
the reader with `identities.read`, and verifies the signature's bytes by
the identity's root, as the root's scheme reads them; `signatures.read`
does the same from the link of the signature. So verifying a signature
takes the blobs of its identity, but not that of the object signed, since
the digest it signs is in the link. It gives the signature's object with
the identity it read as `identity`, the link of what it is over as
`object`, and the signature as bytes. Reading a signature with `decodeObject` and the signature schema
alone, as a viewer of arbitrary objects would, reads its fields without
verifying it.

`sign` signs the link of an object, so it takes anything that has one. The
signature it gives has as `identity` the identity whose root is the
signer's key, and its `blobs` go along with the signature. It writes the
identity before the signer signs and verifies the signature after, so a
signer is not asked for a signature for an identity that would not read,
and a signer whose signature does not verify is refused.

A server that handed out a nonce can build the login object of the example
in `@estoc/object` itself, and take back only the signature, with the
identity's blobs:

```ts
import { loadSignatures, SoftwareSigner } from "@estoc/identity";
import { decodeObject, encodeObject, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";

const signatures = await loadSignatures(defaultValidator);
const signature = await signatures.sign(object, SoftwareSigner.fromSecretKey("ed25519", secretKey));
// The client sends signature.bytes and signature.identity.blobs.

const expected = encodeObject(login, { audience: "https://app.estoc.dev", nonce: "6f1c0a9e" });
const signed = decodeObject(signatureBytes, signatures.schema);
const read = await signatures.verify(signed, new Map(identityBlobs.map((bytes) => [linkOf(bytes), bytes])));
const user = read.object === expected.link ? read.identity : undefined;
```

One identity can sign one object more than once, as a wallet need not sign
deterministically, and each of those signatures verifies. Finding the
signatures over an object takes an index by the link they name, so hand an
object over together with its signatures.
