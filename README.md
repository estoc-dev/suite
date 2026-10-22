# estoc-dev/suite

Estoc rebuilt from the offline-first end. An identity is generated on the
device, data lives on the device, and documents are signed and verified
there with no network. Reaching other people is a layer added on top:
DIDComm is one transport that can attach later, not the shape of the core.

## Data and semantics

Estoc does not own the data it reads. An object is data bound to the
schema it is written to and named by the hash of its bytes. Anyone can
write one, to any schema, and what it means is up to whoever reads it.
Estoc is one reader among others, so an application written elsewhere
stands where Estoc does: it can read Estoc's objects its own way, and
Estoc reads its objects once it has a reading of their schema.

The packages fall on the two sides of that line.

- The substrate is how bytes become a value with a link and a schema, and
  how blobs travel together: the encodings, objects, schemas and validators
  of `@estoc/object`, and `@estoc/bundle`. Like JSON or zip, it has to be
  shared, and it gives no meaning and no reader an advantage.
- Semantics are everything that carries meaning: identities, signatures,
  authorizations, mailboxes. Estoc writes them, and they do nothing that a
  semantics written elsewhere could not.

Nor are objects tied to one encoding. Data is in an encoding and schemas
in a language over it, here JSON and JSON Schema; deterministic CBOR with
CDDL would serve as well, and `@estoc/object` depends on what such a pair
provides rather than on JSON. What Estoc writes so far is JSON. A bundle
names the encoding of its root, and carries blobs of any encoding.

A semantics is code, and Estoc at heart is a set of semantics that a
computer can run.

A program has types of its own, such as `Signature` or `Authorization`, and
reads objects into each through a `Semantics`, which holds one reading for
each schema it takes and checks each object against its schema before the
reading sees it. A semantics that writes holds a writing as well, for the
one schema the program writes its values to now.

- A semantics goes with its type. There is no registry from every schema to
  whatever reads it: a reader knows what it expects, and picking a type by
  a registry would be guessing.
- Each schema reads straight into the current type, with no chain from one
  version to the next. When the type changes, the compiler points to each
  reading that no longer fits it.
- Reading does not write again. A value can keep the link of the object it
  was read from, so the signatures over that object still apply to it. Read
  and written to another schema, the same content would be a new object that
  no one has signed.
- Which schemas stand for a type is the reader's to say, in its semantics,
  and not anything a schema says of itself.

A schema is named by its link, so a schema that changes is another schema.
A program's own newer schema, its older one and another application's are
then alike: each is one more reading in a semantics. Keeping up with one's own
past and reading another application's objects are the same work.

## Packages

- `@estoc/identity`: identities in their schemes, and signing and
  verifying with them. It knows keys, not JSON.
- `@estoc/object`: encodings and schema languages, objects, schemas,
  validators and semantics; JSON and JSON Schema as the pair in use; and the
  semantics of identities and signatures.
- `@estoc/authorization`: one identity letting another act for it, offline.
- `@estoc/bundle`: blobs carried together, as a folder or a zip, with one
  object as the way in.
- `@estoc/mailbox`: where messages to someone can be sent, sealed to the
  receiver's key.

## Development

One pnpm workspace; packages go under `packages/` as they are written.

```bash
pnpm install
pnpm typecheck && pnpm test
```
