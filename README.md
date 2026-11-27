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
bundle: an object as the root, and blobs carried with it. Who asks is
whoever stands behind the root, read with the same verifiers as any
object, so neither side rests on a connection, a session or a credential.
The same bundle can go over HTTP, through a mailbox, or as a file.

A signature does not say when it was made, and whoever holds a bundle can
send it again. So a request either does no harm when it comes again, as
opening an account at a mailbox service does not, or its object holds
what makes it fresh, such as a nonce.

## Packages

The substrate turns bytes into values with a link and a schema, and
carries and keeps blobs. It is shared, as a file format is: the Estoc
Object Format is deterministic CBOR, which any CBOR decoder reads, and it
gives no meaning and no reader an advantage.

- `@estoc/object`: the Estoc Object Format, in deterministic CBOR, and
  over it objects and schemas. A schema is an object of a title and fields
  of seven types, and what fits it is checked here.
- `@estoc/schema`: the functions that the packages below write their
  schemas with.
- `@estoc/bundle`: blobs carried together in one file, with one object as
  the way in, as they travel between programs.
- `@estoc/store`: the blobs that come to a user and those they write,
  kept on their device, with the Records of what their programs said and
  the Secrets, which they keep to themselves, among them; and the indexes
  an application fills from them.
- `@estoc/inspector`: what a link reads as by what the blob says of
  itself, with no schema in hand: its fields, the schema it names and the
  links in its data.
- `@estoc/inspector-web`: a page that opens a bundle and shows what the
  inspector reads of its blobs, from the root along the links.
- `@estoc/explorer`: a program that holds a store and answers the pages
  that show it, over a channel that carries calls one way and replies the
  other: the lists it has of what the store holds, a page of one, a blob
  by its link, the actions it performs, and one of them performed on a
  request.
- `@estoc/explorer-web`: the pages that the explorer gives. One shows a
  list as a table with a column for each field of the schema its rows are
  written to, a page at a time. Another shows a blob: the schema it
  names, its fields, what the pages read it as, and a link to follow for
  each link it holds. An action has a page with a form of the fields of
  its request schema, which has the explorer perform it and shows the
  result and what was committed.

Semantics carry meaning. Estoc writes them, and they do nothing that a
semantics written elsewhere could not.

- `@estoc/identity`: keys in their schemes, an identity written as an
  object that names its root key and signed by that key, which signs for
  it itself or through the agents it lists, and the signatures made for it.
- `@estoc/people`: the people of the identity versions a store holds, who
  say which version of an identity is current and whether a signature made
  for it is honored.
- `@estoc/lineage`: versions strung into a series by anyone, as a chain
  of nodes that each carry the link of one version and name the node
  before, with no authority over what comes next. The schemas of a
  format's versions are strung the same way, and an object of any version
  is read as the same shape.
- `@estoc/blog`: a post, with its title and date, that links to its body,
  and bodies written to a schema for each format, such as Markdown, which a
  program reads as HTML by the schema a body names.
- `@estoc/mailbox`: where messages to someone can be sent, sealed to the
  receiver's key, and the records of what came in and went out.
- `@estoc/mailbox-service`: a service that keeps messages for receivers
  who are not online, reached by its identity, and opening an account
  there by signing its offer.

## Development

One pnpm workspace; packages go under `packages/` as they are written.
What a package does is said by its code and shown in its tests. A comment
says only what the code cannot, such as why a choice was made.

```bash
pnpm install
pnpm check && pnpm typecheck && pnpm test
```

Biome formats and lints the code; `pnpm fix` applies what it can.
