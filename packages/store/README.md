# @estoc/store

A store keeps what a user writes and what comes to them, on one device. Its
truth is objects: a record of each thing the user did, such as writing a
note or receiving a bundle, and the blobs those lead to. Secrets belong in
a keystore and the state of a running program in its own place, and neither
is an object.

A store holds two things.

- **Blobs by link**: any bytes, objects or not, kept under their link. A
  blob is added once and not changed, and is got by its link; the blobs are
  not listed. Blobs from anyone can be kept together: a link names one
  blob, so a blob someone sends can neither replace nor change one already
  kept.
- **What was written here**: the links of the objects the user wrote. It is
  the one thing in a store that is not a blob.

```ts
import { json } from "@estoc/object";
import { MemoryBackend, Store } from "@estoc/store";

const store = new Store(json, new MemoryBackend());
const note = notes.encode("hello");
const signature = await signatures.sign(note, signer);
await store.write({ mine: [note, signature], blobs: [signature.identity.bytes] });

for await (const link of store.mine()) …;       // note.link, signature.link
await store.read(signatures, signature.link);   // the signature, verified
```

## What is listed

Only what the user wrote is listed, and everything else is reached from it.
Anyone can send a bundle to a mailbox, and a bundle can carry an object of
any schema, so listing every blob of a schema would list an unsigned contact
that a stranger slipped in among the user's own contacts.

What comes from elsewhere comes in through something the user does, and that
is an object the user writes: a record of receiving a bundle, of taking a
card, of importing a file. The blobs come in the same write, unlisted, and
are read by following links from the record. A reader then knows they came
from elsewhere without any query having to say so. Something signed carries
its authority in its signature, and reads the same when reached by a link.

An unsigned object has no author to tell who wrote it, and what a bundle
leads to can include the user's own objects, as when someone replies to
them. So the store keeps the list itself rather than working it out.

## Writing

A write puts in a batch: objects written as the user's, under `mine`, and
the blobs that go with them, under `blobs`. Each is copied and hashed as it
comes in, so the store keeps blobs under the links it computed. What is
written as mine has to be an object of the store's encoding, or the whole
batch is refused. Blobs go in before the links that list them, so a write
cut short leaves at worst blobs that nothing lists.

There is no transaction that reads and then writes. Two devices that each
check that something is missing before writing it will both write it, and
when their stores are joined there are two. What has to come out as one is
written so that every device writes the same object, with the same link.

## Reading

`closure(link)` gathers the blob that `link` names and every blob it leads
to that the store holds. A blob leads to the links its encoding finds in it,
the schema of an object among them, so an object leads to its schema when
the store holds that. A blob of another encoding, such as an image, leads
nowhere, and a blob the store does not hold is left out with whatever it
would lead to. The closure of an object is what a bundle carrying it holds:

```ts
const files = writeBundle(signature, (await store.closure(signature.link)).values());
```

`read(semantics, link)` reads an object through a semantics, with its
closure as the blobs that the reading follows. A store is asynchronous,
since storage in a browser is, while a semantics reads from blobs at hand;
gathering the closure first leaves semantics as they are.

## Backends

A store keeps its blobs and its list in a backend, which keeps bytes and
links as it is given them; the store does the hashing and decoding.
`MemoryBackend` keeps them in memory, for tests and for a program that
keeps nothing once it ends.
