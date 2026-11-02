# estoc-dev/suite

Estoc rebuilt from the offline-first end. An identity is generated on the
device, data lives on the device, and documents are signed and verified
there with no network. Reaching other people is a layer added on top:
DIDComm is one transport that can attach later, not the shape of the core.

## Data and semantics

Estoc does not own the data it reads. An object is data bound to the
schema it is written to and named by the hash of its bytes. Anyone can
write one, to any schema, and what it means is up to whoever reads it.
Estoc is one reader among others: an application written elsewhere can
read Estoc's objects its own way, and Estoc can read the application's.

A program reads an object with the schema it expects, and refuses it
unless its data fits. What a schema cannot say, such as whether a
signature verifies, is left to verifiers: each works it out from the
object and the objects it links to, and gives a value, such as a
`Signature`, that only it can make.

What one program asks of another, and what the other answers, is a
bundle: an object as the root, with the blobs in its closure. Who asks is
whoever stands behind the root, read with the same verifiers as any
object, so neither side rests on a connection, a session or a credential.
The same bundle can go over HTTP, through a mailbox, or as a file.

A signature does not say when it was made, and whoever holds a bundle can
send it again. So a request either does no harm when it comes again, as
opening an account at a mailbox service does not, or its object holds
what makes it fresh, such as a nonce.

## Packages

The substrate turns bytes into values with a link and a schema, and
carries and keeps blobs. Like JSON or zip, it is shared, and it gives no
meaning and no reader an advantage.

- `@estoc/object`: encodings and schema languages, objects, schemas and
  validators; JSON and JSON Schema as the pair in use.
- `@estoc/bundle`: blobs carried together, as a folder or a zip, with one
  object as the way in, and packed to travel between programs.
- `@estoc/store`: the objects a user writes, and the blobs that come with
  them, kept on their device; and the indexes an application fills from
  the user's records.

Semantics carry meaning. Estoc writes them, and they do nothing that a
semantics written elsewhere could not.

- `@estoc/identity`: keys in their schemes, an identity written as an
  object that names its root key and signed by that key, which signs for
  it itself or through the agents it lists, and the signatures made for it.
- `@estoc/mailbox`: where messages to someone can be sent, sealed to the
  receiver's key, and the records in a store of what came in and went out.
- `@estoc/mailbox-service`: a service that keeps messages for receivers
  who are not online, reached by its identity, and opening an account
  there by signing its offer.

## Development

One pnpm workspace; packages go under `packages/` as they are written.

```bash
pnpm install
pnpm check && pnpm typecheck && pnpm test
```

Biome formats and lints the code; `pnpm fix` applies what it can.
