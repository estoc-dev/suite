# @estoc/store

A store keeps what a user writes and what comes to them, on one device. Its
truth is objects: a record of each thing the user did, such as writing a
note or receiving a bundle, and the blobs in the closures of those records.
What the user keeps to themselves, such as a secret key, is an object too,
kept in a private store beside the store. The state of a running program
is kept in its own place and is not an object.

A store holds two things.

- **Blobs by link**: any bytes, objects or not, kept under their link. A
  blob is added once and not changed, and is got by its link; the blobs are
  not listed. Blobs from anyone can be kept together: a link names one
  blob, so a blob someone sends can neither replace nor change one already
  kept.
- **Records**: the links of the objects the user wrote. They are the one
  thing in a store that is not a blob.

An object of the store's encoding links to the blobs whose links it holds,
its schema among them. Any other blob is bytes and links to nothing: an
image, or JSON that names no schema, whatever links it seems to hold, so
an attachment does not send the store after blobs. The closure of a blob is the
blob and every blob it links to, directly or through others. Every blob a
store holds comes with its closure, and a write adds only the blobs in the
closures of its records.

```ts
import { encodeObject, json } from "@estoc/object";
import { MemoryBackend, Store } from "@estoc/store";

const store = new Store(json, new MemoryBackend());
const note = encodeObject(noteSchema, { text: "hello" });
const signature = await actor.sign(note);
// `schemas` are the bytes of each schema the program writes to; the store keeps those named here.
await store.write({ records: [note, signature], blobs: [...signature.signedIdentity.blobs, ...schemas] });

for await (const link of store.records()) …;                       // note.link, signature.link
await signatures.read(signature.link, store, noIdentityVersions);  // the signature, verified
```

## What is listed

Only what the user wrote is listed, and everything else is reached from it.
Anyone can send a bundle to a mailbox, and a bundle can carry an object of
any schema, so listing every blob of a schema would list an unsigned contact
that a stranger slipped in among the user's own contacts.

What comes from elsewhere comes in through something the user does, and that
is an object the user writes: an `Inbound` record, of receiving a bundle at a
mailbox, of taking a card, of importing a file. The blobs come in the same
write, unlisted, and are read by following links from the record. A reader
then knows they came from elsewhere without any query having to say so.
Something signed carries its authority in its signature, and reads the same
when reached by a link.

An unsigned object has no author to tell who wrote it, and the closure of
a bundle's root can include the user's own objects, as when someone replies
to them. So the store keeps the list itself rather than working it out.

An index can still read the blobs a store holds by schema, as one over
`selectedBlobs`, and that is for objects that carry their authority in a
signature. A signed identity reads the same whoever sent it and wherever it
sits in a closure, and all that a stranger can send is an identity version
its root signed. An unsigned contact read this way would be the stranger's,
among the user's own. The types do not tell the two apart, so this rule is
kept by the schema a program gives it. A `Store` has no method that lists its
blobs.

## Writing

A write puts in a batch: objects the user writes, under `records`, and
the blobs that go with them, under `blobs`. Each is copied and hashed as it
comes in, so the store keeps blobs under the links it computed.

Of the blobs, it keeps those in the closures of the records, and drops the
rest. Nothing listed would reach them, so they could only wait to
be collected. A program can then give the schemas it writes to with every
write, and a bundle can carry blobs outside its root's closure, without
either leaving anything behind.

The whole batch is refused when:

- a record is not an object of the store's encoding, or
- a blob in a record's closure is neither in the batch nor held by the
  store: the schema of an object, or a blob its data links to.

So the schemas of objects come with them unless the store holds them
already, and a bundle is taken in only with the closures of its objects,
apart from what the receiver holds already.

A refused batch rejects with a `RefusedBatch`, and the same batch is
refused again until the store holds what was missing. A backend that fails
rejects with an error of its own, so a receiver can tell a bundle it will
not take from a write that may go through the next time.

Each blob goes in after the blobs it links to, and before the links that
list it, so a write cut short leaves at worst blobs that nothing lists,
each with its closure.

A store keeps the order it took its blobs in. `positionOf(link)` gives how
many blobs it had taken in before that one, or `undefined` for one it does
not hold. A blob is taken in by the first write that holds it, and writing
it again leaves it where it was. A store only grows, so a blob keeps its
position, and a reader can tell what the store held when the blob came in,
as `@estoc/identity` does to honor a signature by the identity versions the
store held when it took the signature in.

There is no transaction that reads and then writes. Two devices that each
check that something is missing before writing it will both write it, and
when their stores are joined there are two. What has to come out as one is
written so that every device writes the same object, with the same link.

## Staging

What comes from elsewhere is verified before it is written, as a client
reads who signed a Service it reaches, and read again later from the
store. For the two to come out the same, the first is read from the store
as it will be once the batch is written. `stage(batch)` gives that, a
`StagedStore`: the blobs the store holds and those of the batch that `write`
keeps, and the links of the store's records with those of the batch.
`commit` writes the batch, as `write` does.

```ts
const stagedStore = await store.stage({ records: [{ bytes: bundle.root }], blobs: bundle.blobs() });
const people = await view(stagedStore, { index: seenIdentityVersions, read: (rows, reader) => identityVersions.people(rows, reader) });
const signature = await signatures.read(bundle.link, stagedStore, people);
// … whether whoever signed is someone to take it from …
await stagedStore.commit();
```

A batch that `write` refuses is refused when it is staged, before
anything reads it. A staged batch gives the blobs that will be kept and no
others, so nothing verified on it has a blob in its closure that the store
will not hold. `scan` and `view` take a staged batch as they take a store,
so the rows and the objects they name come from the store as it will be.

Staged on a store that holds nothing, a batch is read by what it holds
alone, which is what its sender chose to show. Staged on the user's
store, it is read by what the user has seen as well, so an identity version
that took an agent out applies even when the batch leaves it out.

The batch is taken in only once it is committed. The `positionOf` of a
staged batch is the store's, and gives nothing for a blob that only the
batch holds, so a reader takes what the batch adds as coming in now.
`commit` takes the blobs in one after another, so what depends on the order
the store took them in can read otherwise once the batch is committed, such
as a signature the batch holds before an identity version that took its
agent out.

The records of a staged batch are listed before anything has verified
them. A row stands on its object and its closure, as an identity version
stands on its root's signature, and not on whether the user took the
object.

The batch is fixed when it is staged, and the store is read as it is at
each read, so what is written to the store afterwards shows on the staged
batch too. What is verified on it reads the same from the store once it is
committed when nothing else is written in between, apart from what depends
on that order. A write in between, such as of an identity version that took
an agent out, can change what a view comes to when it is viewed again, on
the staged batch as on the store. The rows a value already viewed was worked
out from stay as they were, though a value that asks the store later where
a blob was taken in finds where `commit` put it. `commit` does not verify
the batch again: as with a write, there is no transaction that reads and
then writes.

A store only grows, so what a staged batch found held is still held when
it is committed, whatever was written in between. A batch that is not
committed leaves nothing, and committing it again writes nothing more. A
staged batch is not a store: it has no `write`, `closure` or `stage`.

## Reading

`closure(link)` gathers the closure of the blob that `link` names, and rejects
when the store does not hold all of it; `get` gives nothing for a blob the
store does not hold. The closure of an object is what a bundle carrying it
holds:

```ts
const files = writeBundle(signature, (await store.closure(signature.link)).values());
```

A store is a `Reader`: `readObject` reads an object from it by link, and a
verifier such as `signatures.read` reads from it the blobs it needs, each
when it comes to it, without gathering a closure first. Like every reader,
it gives under a link only the blob that the link names: `get` and
`closure` hash what the backend gives back, and throw when the backend
gives other bytes, as a damaged disk may.

## Indexes

A store has no index of its own. An application makes its own, of the
records the user writes: an `Index` over `selectedRecords` reads the records that a
`Selection` takes, and gives rows of what the selection reads each one as. A row is an
object too, written to a schema that the index names, and `rows` gives the
data of each. The rows of a record depend on it and its closure, which the
selection and `rows` read by link from the `Reader` they are given, and on
nothing else. An index is the set of the rows its records give: the same data
given twice is one object, with one link, so the order they come in and how
often make no difference. What depends on what else is written, such as
whether something replaced a record, is worked out from the rows when they
are read.

An index says which rows there are, and `orderedBy` in what order to read
them: it names fields of the rows, the first counting most, and gives the
index in that order, which `scan` reads.

- A field that a row leaves out comes before any value.
- Numbers are in their order, strings in the order of their code units, and
  any other value, such as a link, in the order of its bytes in the encoding.
- Rows that hold the same in all of those fields are in the order of their
  links.
- One index can be given several orders. They share its rows, so a store
  reads each record once however many of them it is scanned in.

```ts
import { objectsOf } from "@estoc/object";
import { integer, link, schema, string } from "@estoc/schema";
import { indexOver, scan, selectedRecords } from "@estoc/store";

// A note under one of its tags.
const taggedSchema = schema("Tagged", { tag: string(), at: integer(), note: link() });

// Notes by tag, oldest first: a row for each tag of a note, from a
// `noteSchema` whose objects hold `tags` and `at`.
const tagged = indexOver(selectedRecords(objectsOf(noteSchema)), taggedSchema, ({ link, data }) =>
  data.tags.map((tag) => ({ tag, at: data.at, note: { $link: link } })),
);
const byTag = tagged.orderedBy("tag", "at");

const rows = await scan(store, byTag);
for await (const { data } of rows.range(["lunch"])) …; // `data.at`, `data.note`
```

Rows are kept in memory, beside the store, and are not blobs of it: its `get`
gives none of them, a bundle gathered from it holds none, and an index over
its blobs reads none.

An index comes only from `indexOver`, of one source, and from `union`, of
indexes whose rows are of one schema, so what an index reads is said by its
sources and not worked out in `rows`. A source says where what it reads is
listed and what each is read as, together: `selectedRecords` and
`selectedBlobs` give the records and the blobs of a store that a selection
takes, and another index is a source of its own rows. Each part of a union
reads what its own source lists and hands what it reads that as to its own
rows, so the rows of objects of several schemas, or of several selections of
one schema, need not tell one kind of object from another.

`scan` goes through all that the user wrote. It hands each record to each
selection of the index, and what the selection reads it as to `rows`. A
`SelectionBySchema` is handed instead the record read with its schema, and
only a record of that schema: a record is checked against a schema once,
however many selections by that schema read it. What came from elsewhere
reaches `indexOver` only by following links from what the user wrote. A blob
is read from the store once for a record, the record among them, however
many selections and rows read it. `range(prefix)` gives the rows that hold
`prefix` in the first fields of the order, one value for each, in the order
of the index. What does not fit in
rows, such as a count, an application keeps in a fold of its own, which
then has to come to the same whatever the order and however often an
object comes.

An index fails on what a source of it or its `rows` throw on, and on what
they give a row of whose data does not fit the schema of the index. That
gives no rows of that source, and the scan goes on with the rest:

- The rows list each in `failures`, with its link as `item` and the `error`,
  along with what each index that this one reads failed on. The rows are short
  of whatever those would have given, under any prefix, as what failed gave no
  row to tell where it belongs.
- A scan of an index that reads only records, itself and through the indexes
  it reads, throws the error of the first failure: what it reads is what its
  user wrote, so a failure is a mistake to be seen. A scan of one that reads
  blobs gives the rows with their failures, as anyone can send a blob that it
  fails on. `scan(store, index, { throwsOnFailure })` says which a scan does,
  whatever the index reads.
- A failure is kept with the rows, so a later scan does not read that again.
  It reads what was listed since, and then throws or gives the rows, as it
  does on a failure it has just found.

A store keeps in memory the rows of each index it is scanned for, and those
rows in each order it is scanned in, and a
later scan reads only the records listed since, those that another store on
the same backend wrote among them. The rows of a record depend on it and
its closure alone, and a store only grows, so the rows of the records read
before still hold. A private store keeps its own, and a staged batch reads
its records on top of those its store keeps. The rows are kept for an
index as long as the program holds it, and their order for as long as it
holds what `orderedBy` gave, so a program makes each once:
an index made again by `indexOver` is another, and is read from all the records,
as each index is once a program starts.

An index over `selectedBlobs` reads the blobs a store holds in place of its
records, for objects that carry their authority in a signature, as
[What is listed](#what-is-listed) says. `selectedBlobs` takes a
`SelectionBySchema`, which looks only at the objects of its schema:

```ts
import { indexOver, selectedBlobs } from "@estoc/store";

// The identity versions a store holds, however deep in a closure they came.
// One whose root did not sign it gives no row.
const identityVersionsHeld = indexOver(
  selectedBlobs(identityVersions.selection),
  identityVersions.schema,
  (identityVersion) => [identityVersion],
).orderedBy(...identityVersions.order);
```

- A write keeps only the blobs in the closures of its records, so these are
  the blobs reached from what the user wrote, and a write cut short can leave
  some besides, each with its closure.
- A blob that is not an object in the encoding of the schema, such as an
  attachment, is not one of these, as an object of another schema is not.
- Anyone can send a blob that names the schema and does not fit it, or that
  `selection` or `rows` throw on. The index fails on it as on a record, and a
  scan gives the rows without those of such a blob, with it among their
  `failures`, where a mistake in `selection` or `rows` shows as well.
- What is out of reach of links is out of reach here too: what is encrypted,
  or a bundle wrapped up in a blob, is one blob of bytes.
- A link does not say what it names, so a scan reads every blob, attachments
  as well, once for each index. A later scan reads only the blobs put since. A
  staged batch reads the blobs it keeps on top of the rows its store keeps. A
  private store reads only the blobs kept in it, as
  [Private stores](#private-stores) says.

Rows that catch what they fail to read, so as to give none of something
that came from elsewhere and does not read as they expect, cannot tell that
from a store that fails. A scan therefore fails when the store throws, or
gives no blob, for a link that a selection or its rows read, even where they
catch it: the rows of that record would be cut short. A scan that fails
leaves the rows a store keeps as they were, failures among them, so the next
one reads that record again. The same goes for an index over blobs, and for
a blob that it reads and that turns out to be no object of its schema.

An index is itself a source. One over another index reads the rows of that
one in place of records, each as the object it is, so what one index works
out, another can go on from:

```ts
// The tags that notes hold, each once, from the rows of `tagged`.
const tagSchema = schema("Tag", { tag: string() });
const tags = indexOver(tagged, tagSchema, ({ data }) => [{ tag: data.tag }]);
```

It reads `tagged` and not `byTag`: the rows of an index are the same whatever
order they are read in.

- It reads the rows that the other index gives and nothing else. Anyone can
  send an object of the schema of those rows, and the store may hold one, as a
  record even: it is no row of that index, so it does not reach this one. What
  a record stands on is that the user wrote it, and what a row stands on is
  that its index gave it.
- Its `reader` gives those rows by link, those of the indexes they were
  derived from, the schemas all of them are written to, and what the store
  holds, so a row can name the row or the record it came from, and the
  closure of a row can be read whether or not the store holds its schema.
- It is an index as any other: its rows depend on the row read and its
  closure alone, a store keeps them and reads only the rows given since, and
  another index can read it in turn. A staged batch reads what the other index
  gives of the batch on top of the rows its store keeps, and a private store
  keeps its own.
- The rows of the other index are kept once, for its own orders and for each
  index over it, so a record is read once for all of them.
- It fails on a row that its `rows` throw on, as on a record, and its failures
  include those of the other index. A scan of it throws on them unless one of
  the indexes it reads through reads blobs.

## Views

What depends on what else is written is worked out from the rows when they
are read, and a `View` does it: an index, and `read`, which works a value
out from the rows of that index, reading what they name from the store,
which also gives where it took each in.
The index says which objects are read, and `read` what their rows come to,
so an application can give the one and a module that knows what the objects
mean the other. The two meet in the schema of the rows.

```ts
import { readObject, type Json } from "@estoc/object";
import type { DataOf } from "@estoc/schema";
import { view, type View } from "@estoc/store";

// The latest note of a tag, from the rows of `byTag`.
type Latest = { noteTagged(tag: string): Promise<DataOf<typeof noteSchema> | undefined> };

const latest: View<Json, DataOf<typeof taggedSchema>, readonly ["tag", "at"], Latest> = {
  index: byTag,
  read: (rows, reader) => ({
    async noteTagged(tag) {
      let last: Link<unknown> | undefined;
      for await (const { data } of rows.range([tag])) last = data.note.$link;
      return last === undefined ? undefined : (await readObject(reader, last, noteSchema)).data;
    },
  }),
};

const notes = await view(store, latest);
await notes.noteTagged("lunch");
```

`view(store, view)` scans the store for the index and reads the rows with
the store, so the rows, the objects they name and where each was taken in
come from one store. When `read` gives a promise, as it does when it works the value
out from all the rows at once, `view` gives what the promise resolves to.
The rows are of what the store held when it was viewed: what is written
later is taken in when it is viewed again. A value that asks the store later
where a blob was taken in finds where the store has taken it in by then.

## Receiving

What comes from outside a store is kept with a record that it came in,
whichever way it came. An `Intake` writes the record:

```
Inbound  {"bundle": <link of the root>, "at": <milliseconds>, "via": <link>}
```

```ts
import { Intake } from "@estoc/store";

const intake = new Intake(store);
await intake.receive(bundle);          // handed over out of band
await intake.receive(bundle, mailbox); // at a mailbox
```

`at` is by the clock of the device that writes the record, so a sender has
no say in it. `via` links to the channel it came in by, and is left out for
what was handed over out of band. Which channel it is shows in the object it
links to, so another channel is another kind of object and not another
schema, and an index that reads `inboundSchema` covers them all.

`receive` takes anything with a `link` and `blobs()`, as a `Bundle` has, and
the channel's object, which it keeps with its schema whether or not the
store held them. The bundle, the channel and the record go in one write,
which is refused with a `RefusedBatch` when a blob in the closure of the
bundle's root or of `via` is neither in that write nor held by the store.
What comes in twice is recorded twice, and a reader takes the earliest `at`:

```ts
// When each bundle came in: the first row of a root is the earliest.
const arrivalSchema = schema("Arrival", { bundle: link<never>(), at: integer() });
const cameIn = indexOver(selectedRecords(objectsOf(inboundSchema)), arrivalSchema, ({ data }) => [
  { bundle: data.bundle, at: data.at },
]).orderedBy("bundle", "at");
```

What the records promise is little, so that every way in can keep it:

- An `Inbound` says that something came in and nothing more. Its writer
  promises that the store holds the closure of `bundle`, and that `at` is by
  its own clock. What calls `receive` can check more, such as not keeping
  what does not open, but a reader cannot count on that.
- `via` names a channel and says nothing about what was checked.
- A reader of `Inbound` records verifies signatures and identity versions
  itself. Anyone can send a bundle to a mailbox.
- A program that checks what came in, and whose judgement another program
  reads, writes a mark: a record of its own that links to the `Inbound`, of a
  schema in its own package, that says what it checked. One `Inbound` can
  have marks of several programs, or none. To take a program's judgement,
  read its marks by their schema.
- A mark cannot be sent from outside. What is sent stays in the closure of an
  `Inbound`, and is not a record.
- A mark is a judgement made at that time, and stays as it is. What can change
  later, such as whether the identity version a signature carries still
  counts, is worked out when it is read.
- Programs that share a store need no signature on a mark. A mark is no
  boundary between them either: whatever writes to a store can write any
  record.

`write` takes any record. That what comes from elsewhere goes through an
`Intake`, and that a record written directly is the user's own, is a rule for
programs that the store does not enforce.

## Private stores

Some objects are the user's alone, such as the secret key of a mailbox.
They are written to a `PrivateStore`, which is kept beside a store, in a
backend of its own, and is written to and read like one. Being private is
where an object is kept, not something its schema says: an object of any
schema can be kept on either side.

```ts
import { MemoryBackend, PrivateStore, Store } from "@estoc/store";

const store = new Store(json, new MemoryBackend());
const privateStore = new PrivateStore(store, new MemoryBackend());
await privateStore.write({ records: [key], blobs: [keySchema.bytes] });

await privateStore.get(mailbox.link);  // from the store beside
await store.get(key.link);     // undefined
```

The private store reads the store beside it, so what it keeps can link to
what the store holds, and its `get` gives both. The store does not read the
private store. A blob that only the private store keeps is not one the
store holds, so the store refuses to write an object with one in its
closure, and its `get` and `closure` do not give one. A private store has
no `closure` and is not a `Store`, so it cannot be given where a store is
asked for, as by what gathers bundles. Being private is where bytes are
kept, not a mark on them: bytes that are also written to the store are the
store's as well.

A write follows the rules of a store's, with what the store beside holds
counted as held: a blob that either side holds need not come in the batch,
and one that the store holds already is not kept again. `scan` and `view`
take a private store as they take a store. An index over blobs reads only the
blobs kept in the private store, as its `records` lists only what was written
to it, so one that the store beside holds is read only by following a link.
Its `positionOf` gives where it kept a blob, and nothing for one that only
the store beside holds.

A private store is only on the device that keeps it. Like a store, it only
grows, so a key that is no longer used is still kept. Whether it is
encrypted is up to its backend.

## Backends

A store keeps its blobs and its list in a backend, which keeps bytes and
links as it is given them; the store does the hashing and decoding, of
what goes in and of what comes back. The list keeps the order in which
links were first put, and a backend gives it from any point on, so a store
reads only the records listed since it last scanned. A backend gives the links
of its blobs in the same way, which a store uses for an index over blobs, and
where a blob is among them, which is the store's `positionOf`.
`MemoryBackend` keeps them in memory, for tests and for a program that
keeps nothing once it ends.

`SqliteBackend` keeps them in one SQLite file. It runs only in Node, so it
is imported on its own, from `@estoc/store/sqlite`. Each write is one
transaction, which goes in whole or not at all and is on disk by the time
the write resolves. The file is not encrypted, so the file of a private
store goes where only its user can read it.

```ts
import { SqliteBackend } from "@estoc/store/sqlite";

const backend = new SqliteBackend("store.db");
const store = new Store(json, backend);
// …
backend.close();
```

Stores are joined by writing bundles from one to another, not by copying
their files. A file copied while it is open, as by a tool that syncs a
folder, can come out damaged.
