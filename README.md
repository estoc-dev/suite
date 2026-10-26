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
Estoc can read the application's.

The packages fall on the two sides of that line.

- The substrate is how bytes become a value with a link and a schema, and
  how blobs travel together and are kept: the encodings, objects, schemas
  and validators of `@estoc/object`, `@estoc/bundle` and `@estoc/store`.
  Like JSON or zip, it has to be shared, and it gives no meaning and no
  reader an advantage.
- Semantics are everything that carries meaning: identities, signatures,
  authorizations, mailboxes. Estoc writes them, and they do nothing that a
  semantics written elsewhere could not.

Nor are objects tied to one encoding. Data is in an encoding and schemas
in a language over it, here JSON and JSON Schema; deterministic CBOR with
CDDL would serve as well, and `@estoc/object` depends on what such a pair
provides rather than on JSON. What is written so far is JSON: the objects
Estoc writes, and the root of a bundle, which carries blobs of any
encoding.

A semantics is code, and Estoc at heart is a set of semantics that a
computer can run.

A program reads an object with the schema it expects and the type it
declares for that schema's data, and refuses the object unless its data
fits. What a schema cannot say is left to judgments: whether a signature
verifies, or who stands behind an object through a chain of
authorizations. A judgment is worked out from an object and the objects it
links to, read by link as it comes to them, each time the object is read,
and gives a value, such as a `Signature` or an `Authorization`, that only
it can make.

- Objects are what a program keeps, indexes and shows. It need not turn
  each into a type of its own first.
- Which schemas a program reads is its own to say, and not anything a
  schema says of itself. There is no registry from every schema to
  whatever reads it: a reader knows what it expects, and picking by a
  registry would be guessing.
- Reading does not write again. What a program makes of an object can keep
  its link, so the signatures over that object still apply to it. Read and
  written to another schema, the same content would be a new object that no
  one has signed.

A schema is named by its link, so a schema that changes is another schema.
A program's own newer schema, its older one and another application's are
then alike: each is one more schema for the program to read. Keeping up
with one's own past and reading another application's objects are the same
work.

## Packages

- `@estoc/identity`: identities in their schemes, and signing and
  verifying with them. It knows keys, not JSON.
- `@estoc/object`: encodings and schema languages, objects, schemas and
  validators; JSON and JSON Schema as the pair in use; and the judgments of
  identities and signatures.
- `@estoc/authorization`: one identity letting another act for it, offline.
- `@estoc/bundle`: blobs carried together, as a folder or a zip, with one
  object as the way in.
- `@estoc/mailbox`: where messages to someone can be sent, sealed to the
  receiver's key, and the records in a store of what came in and went out.
- `@estoc/mailbox-service`: opening an account, by signing its offer, at
  a service that keeps messages for receivers who are not online.
- `@estoc/store`: the objects a user writes, and the blobs that come with
  them, kept on their device; and the indexes an application fills from
  what the user wrote.

## Development

One pnpm workspace; packages go under `packages/` as they are written.

```bash
pnpm install
pnpm typecheck && pnpm test
```
