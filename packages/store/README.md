# @estoc/store

A store keeps what a user writes and what comes to them, on one device. Its
truth is objects: those the user wrote, those that came from elsewhere, and
the blobs in the closures of them all. What the user keeps to themselves is
an object too, kept beside the store: a mark of what was done on their
devices, such as that they wrote an object, in a private store, and a
secret, such as a secret key, in a secret store. The state of a running
program is kept in its own place and is not an object.

A store holds blobs by link: any bytes, objects or not, kept under their
link. A link names one blob wherever it is kept, and a store holds those
that have come to it: `get` gives nothing for a link whose blob it does not
hold, which another store may. A blob is added once and not changed. Blobs
from anyone can be kept together, as a blob someone sends can neither
replace nor change one already kept. So holding a blob says that it came in,
and not whose it is. The store lists its blobs and nothing else: whose a
blob is, and how it came, is said by the marks of the
[private store](#private-stores) beside.

An object links to the blobs whose links it holds, its schema among them,
and a schema to its root schema. Any other blob is bytes and links to
nothing: an image, or a JSON file, whatever links it seems to hold, so an
attachment does not send the store after blobs. The closure of a blob is the
blob and every blob it links to, directly or through others. Every blob a
store holds comes with its closure, and a write adds only the blobs in the
closures of its roots, the blobs it names to be held.

```ts
import { encodeObject } from "@estoc/object";
import { MemoryBackend, PrivateStore, recordsOf, Store } from "@estoc/store";

const store = new Store(new MemoryBackend());
const privateStore = new PrivateStore(store, new MemoryBackend());
const note = encodeObject(noteSchema, { text: "hello" });
const signature = await actor.sign(note);
// `schemas` are the `blobs` of each schema the program writes to; the store keeps those named here.
await store.write({
  roots: [signature.link],
  blobs: [note.bytes, signature.bytes, ...signature.signedIdentity.blobs, ...schemas],
});
await privateStore.write(recordsOf([note.link, signature.link], Date.now())); // the user wrote both

for await (const link of store.blobs()) …;                          // the blobs in the closure of the signature
for await (const link of privateStore.marks()) …;                   // a record of the note, one of the signature
await signatures.read(signature.link, store, noIdentityVersions);   // the signature, verified
```

## What is listed

A store lists what it holds and a private store what the user did, and the
two say different things. `blobs()` lists what the store holds, which is what
it has seen: anyone can send a bundle to a mailbox, and a bundle can carry
an object of any schema, so the blobs of a schema include an unsigned
contact that a stranger slipped in among the user's own contacts. What is
the user's own is therefore read from the records, which are among the marks
of the private store, and what came from elsewhere is reached from the marks
of its arrivals.

What comes from elsewhere comes in through something the user does:
receiving a bundle at a mailbox, taking a card, importing a file. An
[`Intake`](#receiving) writes the bundle to the store as a root, so the store
holds its closure, and then writes an `Inbound`, a mark of the arrival, to
the [private store](#private-stores) beside. The arrivals are read from the
marks of the private store, as by an index over `selectedMarks`, and the
blobs by following links from an `Inbound`. A reader then knows they came
from elsewhere without any query having to say so. A receive that stops
between the two writes leaves the bundle held, with no mark of it. Something
signed carries its authority in its signature, and reads the same when
reached by a link.

An unsigned object has no author to tell who wrote it, and the closure of
a bundle's root can include the user's own objects, as when someone replies
to them. So what the user wrote is listed, in the private store, rather than
worked out from what the store holds.

A mark is an object, so one can come in a bundle. The store then holds it as
a blob, and it marks nothing: a private store lists the marks written to it,
and reads none from the store beside.

`blobs()` gives the links of the blobs a store holds, each once, in the order
it took them in. It is for what asks what a store holds, such as a tool that
shows it. It tells nothing of who wrote a blob, or of whether the user took
it for their own.

An index can read the blobs a store holds by schema, as one over
`selectedBlobs`, and that is for objects that carry their authority in a
signature. A signed identity reads the same whoever sent it and wherever it
sits in a closure, and all that a stranger can send is an identity version
its root signed. An unsigned contact read this way would be the stranger's,
among the user's own. The types do not tell the two apart, so this rule is
kept by the schema a program gives it.

## Writing

A write puts in a batch: `roots`, the links of blobs that the store is to
hold with their closures, and `blobs`, the roots themselves and what they
link to. A root is an object the user wrote, the root of a bundle that came
in, or any other blob. Each blob is copied and hashed as it comes in, so the
store keeps blobs under the links it computed. The store lists nothing for a
root, and a root that it holds already need not be in the batch.

```ts
await store.write({ roots: [note.link], blobs: [note.bytes, ...noteSchema.blobs] });
await store.write({ roots: [bundle.link], blobs: bundle.blobs() });
```

Of the blobs, the store keeps those in the closures of the roots, and drops
the rest. No root would reach them, so they could only wait to be collected.
A program can then give the schemas it writes to with every write, and a
bundle can carry blobs outside its root's closure, without either leaving
anything behind.

The whole batch is refused when one of `roots`, or a blob in the closure of
one, is neither in the batch nor held by the store: the schema of an object,
or a blob its data links to.

So the schemas of objects come with them unless the store holds them
already, and a bundle is taken in only with the closures of its objects,
apart from what the receiver holds already.

A refused batch rejects with a `RefusedBatch`, and the same batch is
refused again until the store holds what was missing. A backend that fails
rejects with an error of its own, so a receiver can tell a bundle it will
not take from a write that may go through the next time.

Each blob goes in after the blobs it links to, so a write cut short leaves
at worst some blobs of the batch and not its roots, each with its closure.

A store keeps the order it took its blobs in, and `blobs()` lists them in
it. A blob is taken in by the first write that holds it, and writing it again
leaves it where it was. A store only grows, so an index over blobs reads on
from where it left off. The order says nothing of when a blob came: that is
in the marks of the private store beside ([Private stores](#private-stores)).

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
keeps. `commit` writes the batch, as `write` does. What comes from elsewhere is kept
through an `Intake` ([Receiving](#receiving)), whose `stage` stages the bundle
that its `receive` keeps:

```ts
const stagedStore = await new Intake(store, privateStore).stage(bundle);
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

The batch is taken in only once it is committed, and a bundle staged
through an `Intake` is marked only then. So `arrivalsView` has no time for
what only a staged bundle holds, and a reader that asks when it came takes
it as coming in now.

A staged batch holds blobs and lists no marks, so an index over
`selectedBlobs` reads it, and one over `selectedMarks` or `selectedRecords`
has no rows on it.

The batch is fixed when it is staged, and the store is read as it is at
each read, so what is written to the store afterwards shows on the staged
batch too. What is verified on it reads the same from the store once it is
committed when nothing else is written in between. A write in between, such
as of an identity version that took an agent out, can change what a view
comes to when it is viewed again, on the staged batch as on the store. The
rows a value already viewed was worked out from stay as they were. `commit`
does not verify the batch again: as with a write, there is no transaction
that reads and then writes.

A store only grows, so what a staged batch found held is still held when
it is committed, whatever was written in between. A batch that is not
committed leaves nothing, and committing it again writes nothing more. A
staged batch is not a store: it has no `write`, `closure`, `stage` or
`blobs`.

## Reading

`closure(link)` gathers the closure of the blob that `link` names, and rejects
when the store does not hold all of it; `get` gives nothing for a blob the
store does not hold. The closure of an object is what a bundle carrying it
holds:

```ts
const file = encodeBundle(signature.link, (await store.closure(signature.link)).values());
```

A store is a `Reader`: `readObject` reads an object from it by link, and a
verifier such as `signatures.read` reads from it the blobs it needs, each
when it comes to it, without gathering a closure first. Like every reader,
it gives under a link only the blob that the link names: `get` and
`closure` hash what the backend gives back, and throw when the backend
gives other bytes, as a damaged disk may.

## Indexes

A store has no index of its own. An application makes its own, of the
objects the user records: an `Index` over `selectedRecords` reads the recorded
objects that a `Selection` takes, which are what the records among the marks
of a [private store](#private-stores) link to and not the records themselves,
and gives rows of what the selection reads each one as. A row is an object too, written to a schema that the index names, and
`rows` gives the data of each. The rows of a recorded object depend on it and
its closure, which the selection and `rows` read by link from the `Reader`
they are given, and on nothing else. An index is the set of the rows that
what it reads gives: the same data given twice is one object, with one link,
so the order they come in and how often make no difference. What depends on
what else is written, such as whether something replaced an object, is worked
out from the rows when they are read.

An index says which rows there are, and `orderedBy` in what order to read
them: it names fields of the rows, the first counting most, and gives the
index in that order, which `scan` reads.

- A field that a row leaves out comes before any value.
- Numbers are in their order, strings in the order of their code units, and
  any other value, such as a link, in the order of its bytes in the object
  format.
- Rows that hold the same in all of those fields are in the order of their
  links.
- One index can be given several orders. They share its rows, so each
  recorded object is read once however many of them it is scanned in.

```ts
import { LinkValue, objectsOf } from "@estoc/object";
import { integer, link, schema, string } from "@estoc/schema";
import { indexOver, scan, selectedRecords } from "@estoc/store";

// A note under one of its tags.
const taggedSchema = schema("Tagged", { tag: string(), at: integer(), note: link() });

// Notes by tag, oldest first: a row for each tag of a note, from a
// `noteSchema` whose objects hold `tags` and `at`.
const tagged = indexOver(selectedRecords(objectsOf(noteSchema)), taggedSchema, ({ link, data }) =>
  data.tags.map((tag) => ({ tag, at: data.at, note: new LinkValue(link) })),
);
const byTag = tagged.orderedBy("tag", "at");

const rows = await scan(privateStore, byTag);
for await (const { data } of rows.range(["lunch"])) …; // `data.at`, `data.note`
```

Rows are kept in memory, beside what was scanned, and are not blobs of the
store: its `get` gives none of them, a bundle gathered from it holds none,
and an index over its blobs reads none.

An index comes only from `indexOver`, of one source, and from `union`, of
indexes whose rows are of one schema, so what an index reads is said by its
sources and not worked out in `rows`. A source says where what it reads is
listed and what each is read as, together: `selectedBlobs` gives the blobs
of a store that a selection takes, `selectedMarks` and `selectedRecords` the
marks of a [private store](#private-stores) and the objects they record,
`selectedSecrets` the secrets of a [secret store](#secret-stores), and
another index is a source of its own rows. Each part of a union
reads what its own source lists and hands what it reads that as to its own
rows, so the rows of objects of several schemas, or of several selections of
one schema, need not tell one kind of object from another.

`scan` goes through all that the private store records. It hands each
recorded object to each selection of the index, and what the selection reads
it as to `rows`. A
`SelectionBySchema` is handed instead the object read with its schema, and
only an object of that schema: an object is checked against a schema once,
however many selections by that schema read it. What came from elsewhere
reaches `indexOver` only by following links from what the user wrote. A blob
is read from the store once for a recorded object, the object among them,
however many selections and rows read it. `range(prefix)` gives the rows
that hold `prefix` in the first fields of the order, one value for each, in
the order of the index. What does not fit in rows, such as a count, an application keeps in a fold of its own, which
then has to come to the same whatever the order and however often an
object comes.

An index fails on what a source of it or its `rows` throw on, and on what
they give a row of whose data does not fit the schema of the index. That
gives no rows of that source, and the scan goes on with the rest:

- The rows list each in `failures`, with its link as `item` and the `error`,
  along with what each index that this one reads failed on. The rows are short
  of whatever those would have given, under any prefix, as what failed gave no
  row to tell where it belongs.
- A scan of an index that reads only recorded objects, marks and secrets,
  itself and through the indexes it reads, throws the error of the first
  failure: what it reads is what its user wrote, so a failure is a mistake to
  be seen. A scan of one that reads
  blobs gives the rows with their failures, as anyone can send a blob that it
  fails on. `scan(store, index, { throwsOnFailure })` says which a scan does,
  whatever the index reads.
- A failure is kept with the rows, so a later scan does not read that again.
  It reads what was listed since, and then throws or gives the rows, as it
  does on a failure it has just found.

A store, a private store and a secret store each keep in memory the rows of
each index they are scanned for, and those rows in each order they are
scanned in, and a later scan reads only what was listed since, what another
on the same backend wrote among it. The rows of a recorded object depend on
it and its closure alone, and each of the three only grows, so the rows of
those read before still hold. A staged batch reads the blobs it keeps on top
of the rows its store keeps. The rows are kept for an index as long as the
program holds it, and their order for as long as it holds what `orderedBy`
gave, so a program makes each once: an index made again by `indexOver` is
another, and is read from all that is listed, as each index is once a program
starts.

An index over `selectedBlobs` reads the blobs a store holds in place of what
the user recorded, for objects that carry their authority in a signature, as
[What is listed](#what-is-listed) says. `selectedBlobs` takes a
`SelectionBySchema`, which looks only at the objects of its schema:

```ts
import { indexOver, selectedBlobs } from "@estoc/store";

// The identity versions a store holds, however deep in a closure they came.
// One whose root did not sign it gives no row, and is among the failures.
const identityVersionsHeld = indexOver(
  selectedBlobs(identityVersions.selection),
  identityVersions.schema,
  identityVersions.rows,
).orderedBy(...identityVersions.order);
```

- A write keeps only the blobs in the closures of its roots, so these are
  the blobs reached from what the user wrote and from what came in, and a
  write cut short can leave some besides, each with its closure.
- A blob that is not an object, such as an attachment, is not one of these,
  as an object of another schema is not.
- Anyone can send a blob that names the schema and does not fit it, or that
  `selection` or `rows` throw on. The index fails on it as on a recorded
  object, and a scan gives the rows without those of such a blob, with it
  among their `failures`, where a mistake in `selection` or `rows` shows as
  well.
- What is out of reach of links is out of reach here too: what is encrypted,
  or a bundle wrapped up in a blob, is one blob of bytes.
- A link does not say what it names, so a scan reads every blob, attachments
  as well, once for each index. A later scan reads only the blobs put since. A
  staged batch reads the blobs it keeps on top of the rows its store keeps. A
  secret store reads only the blobs kept in it, as
  [Secret stores](#secret-stores) says.

Rows that catch what they fail to read, so as to give none of something
that came from elsewhere and does not read as they expect, cannot tell that
from a store that fails. A scan therefore fails when the store throws, or
gives no blob, for a link that a selection or its rows read, even where they
catch it: the rows of that object would be cut short. A scan that fails
leaves the rows a store keeps as they were, failures among them, so the next
one reads that object again. The same goes for an index over blobs, and for
a blob that it reads and that turns out to be no object of its schema.

An index is itself a source. One over another index reads the rows of that
one in place of recorded objects, each as the object it is, so what one index works
out, another can go on from:

```ts
// The tags that notes hold, each once, from the rows of `tagged`.
const tagSchema = schema("Tag", { tag: string() });
const tags = indexOver(tagged, tagSchema, ({ data }) => [{ tag: data.tag }]);
```

It reads `tagged` and not `byTag`: the rows of an index are the same whatever
order they are read in.

- It reads the rows that the other index gives and nothing else. Anyone can
  send an object of the schema of those rows, and the store may hold one,
  recorded even: it is no row of that index, so it does not reach this one.
  What a recorded object stands on is that the user wrote it, and what a row
  stands on is that its index gave it.
- Its `reader` gives those rows by link, those of the indexes they were
  derived from, the schemas all of them are written to, and what the store
  holds, so a row can name the row or the object it came from, and the
  closure of a row can be read whether or not the store holds its schema.
- It is an index as any other: its rows depend on the row read and its
  closure alone, a store keeps them and reads only the rows given since, and
  another index can read it in turn. A staged batch reads what the other index
  gives of the batch on top of the rows its store keeps, and a private store
  and a secret store keep their own.
- The rows of the other index are kept once, for its own orders and for each
  index over it, so a recorded object is read once for all of them.
- It fails on a row that its `rows` throw on, as on a recorded object, and its
  failures include those of the other index. A scan of it throws on them
  unless one of the indexes it reads through reads blobs.

## Views

What depends on what else is written is worked out from the rows when they
are read, and a `View` does it: an index, and `read`, which works a value
out from the rows of that index, reading what they name by link from the
`Reader` it is given.
The index says which objects are read, and `read` what their rows come to,
so an application can give the one and a module that knows what the objects
mean the other. The two meet in the schema of the rows.

```ts
import { readObject } from "@estoc/object";
import type { DataOf } from "@estoc/schema";
import { view, type View } from "@estoc/store";

// The latest note of a tag, from the rows of `byTag`.
type Latest = { noteTagged(tag: string): Promise<DataOf<typeof noteSchema> | undefined> };

const latest: View<DataOf<typeof taggedSchema>, readonly ["tag", "at"], Latest> = {
  index: byTag,
  read: (rows, reader) => ({
    async noteTagged(tag) {
      let last: Link<unknown> | undefined;
      for await (const { data } of rows.range([tag])) last = data.note.link;
      return last === undefined ? undefined : (await readObject(reader, last, noteSchema)).data;
    },
  }),
};

const notes = await view(privateStore, latest);
await notes.noteTagged("lunch");
```

`view` takes what `scan` takes. It scans that for the index and reads the
rows with it, so the rows and the objects they name come from one place.
When `read` gives a promise, as it does when it works the value
out from all the rows at once, `view` gives what the promise resolves to.
The rows are of what was listed when it was viewed: what is written later is
taken in when it is viewed again.

## Receiving

What comes from outside a store is kept with a mark that says it came in,
whichever way it came. An `Intake` keeps the bundle in the store and writes
that mark to the [private store](#private-stores) beside it:

```
Inbound  {"bundle": <link of the root>, "at": <milliseconds>, "via": <link>}
```

```ts
import { Intake, MemoryBackend, PrivateStore } from "@estoc/store";

const privateStore = new PrivateStore(store, new MemoryBackend());
const intake = new Intake(store, privateStore);
await intake.receive(bundle);          // handed over out of band
await intake.receive(bundle, mailbox); // at a mailbox
```

When something came in, and by which way, is nobody else's to check and
says more than the user means to send, so the `Inbound` is not a blob of the
store, and no bundle gathered from the store carries it.

`at` is by the clock of the device that writes the `Inbound`, so a sender has
no say in it. `via` links to the channel it came in by, and is left out for
what was handed over out of band. Which channel it is shows in the object it
links to, so another channel is another kind of object and not another
schema, and an index that reads `inboundSchema` covers them all.

`receive` takes anything with a `link` and `blobs()`, as a `Bundle` has, and
the channel's object.

- The bundle goes in the store first, as a root with the blobs in its
  closure. It is refused with a `RefusedBatch` when a blob in the closure of
  its root is neither in the bundle nor held by the store, and blobs outside
  that closure are dropped.
- The `Inbound` goes in the private store after, with the channel's object
  and its schema, which are kept there whether or not the store holds them.
- The two are not one write. A stop in between leaves a bundle that the
  store holds with no mark of it, and receiving it again writes the mark.
- What comes in again is marked again with its own `at`, and a reader takes
  the earliest. Two that agree on the bundle, `via` and `at`, as when the
  clock gives the same millisecond twice, are one `Inbound`, listed once.

`stage` takes what `receive` takes and gives the store as it will be once
the bundle is kept, a `StagedStore` ([Staging](#staging)) to verify on. It is
the store alone that is staged: what is verified there, such as who signed
the bundle, is read from blobs of the store, and the mark is the device's
own say. Its `commit` keeps the bundle and then writes the `Inbound`, whose
`at` is the time it was staged.

An index reads when each bundle came in, scanned on the private store:

```ts
// When each bundle came in: the first row of a root is the earliest.
const arrivalSchema = schema("Arrival", { bundle: link<never>(), at: integer() });
const cameIn = indexOver(selectedMarks(objectsOf(inboundSchema)), arrivalSchema, ({ data }) => [
  { bundle: data.bundle, at: data.at },
]).orderedBy("bundle", "at");
await scan(privateStore, cameIn);
```

What an `Inbound` promises is little, so that every way in can keep it:

- An `Inbound` says that something came in and nothing more. Its writer
  promises that the store holds the closure of `bundle`, and that `at` is by
  its own clock. What calls `receive` can check more, such as not keeping
  what does not open, but a reader cannot count on that.
- `via` names a channel and says nothing about what was checked.
- A reader of `Inbound` objects verifies signatures and identity versions
  itself. Anyone can send a bundle to a mailbox.
- A program that checks what came in, and whose judgement another program
  reads, writes a mark of its own to the private store: an object that links
  to the `Inbound`, of a schema in its own package, that says what it
  checked. One `Inbound` can have marks of several programs, or none. To take
  a program's judgement, read its marks by their schema.
- A mark cannot be sent from outside. What is sent is a blob of the store,
  which the private store does not list.
- A mark is a judgement made at that time, and stays as it is. What can change
  later, such as whether the identity version a signature carries still
  counts, is worked out when it is read.
- Programs that share a private store need no signature on a mark. A mark is
  no boundary between them either: whatever is handed the private store can
  write any mark.

That what comes from elsewhere goes through an `Intake`, and that what is
written to the private store is the user's own, is a rule for programs that
the stores do not enforce.

## Private stores

Some objects say what was done on the user's devices, such as when
something was taken in and by which way. Nobody else can check what they
say, and they tell more than the user means to send. Such marks are written
to a `PrivateStore`, which is kept beside a store, in a backend of its own.

```ts
import { encodeObject, LinkValue, objectsOf } from "@estoc/object";
import { Intake, indexOver, MemoryBackend, PrivateStore, Store, scan, selectedMarks } from "@estoc/store";

const store = new Store(new MemoryBackend());
const privateStore = new PrivateStore(store, new MemoryBackend());
// The card came in a bundle, which the store holds.
await new Intake(store, privateStore).receive(card);
// A mark of the program's own schema: that the user took the card, and when.
const taken = encodeObject(takenSchema, { card: new LinkValue(card.link), at: Date.now() });
await privateStore.write({ marks: [taken.link], blobs: [taken.bytes, ...takenSchema.blobs] });

for await (const link of privateStore.marks()) …; // the `Inbound` of the card, then taken.link
await privateStore.get(card.link);                // from the store beside
await store.get(taken.link);                      // undefined

// When each card was taken, from a `takenAtSchema` of the same two fields.
const takenAt = indexOver(selectedMarks(objectsOf(takenSchema)), takenAtSchema, ({ data }) => [
  { card: data.card, at: data.at },
]).orderedBy("card", "at");
await scan(privateStore, takenAt);
```

A private store lists its marks as they are. `write` takes their links
under `marks` and their bytes among `blobs`, and lists each, with no record
of it, and `marks()` gives their links in the order they were first written. A mark is an object of whatever schema
its program gives it, and is a mark because the private store lists it:

- An object of the same schema can come to the store beside, as in a bundle.
  The private store gives it by its link, as it gives any blob the store
  holds, and does not list it, so an index over `selectedMarks` does not read
  it.
- A mark is kept in the private store's backend whether or not the store
  beside holds the same bytes, which anyone can send it. So what the store
  comes to hold changes neither what is listed here nor where it is kept.
- What a batch gives of the closure of a mark, such as its schema, is kept
  here too. A blob of the closure that the batch leaves out counts as held
  when either side holds it, so a mark can link to what the store holds.
- Marks are not signed. That a mark is the user's own rests on what is handed
  the private store: what takes in bundles is handed the store and writes
  there. Whatever is handed the private store can write any mark.

The store does not read the private store, as it does not read a secret
store. A blob that only the private store holds is not one the store holds:
its `get` and `closure` do not give it, and it refuses a batch whose closure
needs it and does not bring it. A private store has no `closure` and is not
a `Store`, so it cannot be given to what gathers bundles. It is not a
`SecretStore` either, so what writes marks is not handed the secrets: a
secret stays on the device that keeps it, and marks are for the user's own
devices.

A record is one kind of mark: an object of `recordSchema` that links to an
object the user wrote, which the store beside holds, and says when the user
wrote it, by the clock of the device that wrote the record. The object goes
in the store as a root, and `recordsOf` gives the batch that records it at
the time given:

```ts
import { recordsOf } from "@estoc/store";

await store.write({ roots: [note.link], blobs: [note.bytes, ...noteSchema.blobs] });
await privateStore.write(recordsOf([note.link], Date.now()));
```

The two writes are not one. The store goes first, since the private store
refuses a record of an object that neither side holds, and a stop in between
leaves an object that the store holds with no record of it.

`scan` and `view` take a private store, and read both sides through it:

- An index over `selectedMarks` reads its marks, each as the object it is,
  and has no rows on a store or a secret store.
- An index over `selectedRecords` reads the objects that the records among
  its marks link to, each once: an object written again is recorded again,
  with the time then, and two records that agree on the object and the time
  by the clock are one mark, listed once. A record that came to the store
  beside, as in a bundle, is not a mark, and records nothing.
- An index over `selectedBlobs` reads the blobs that the store beside holds.
  What only the private store keeps, its marks among them, is not read.

Its rows are kept apart from those of the store beside, so an index over
blobs that is scanned on both is worked out once for each.

`arrivalsView` gives a view of when what the user's devices hold came to
them, by the inbound marks and the records of a private store:

```ts
import { arrivalsView, view } from "@estoc/store";

// Made once and kept, as any view is.
const arrivalsOfCards = arrivalsView(cardSchema);

const arrivals = await view(privateStore, arrivalsOfCards);
await arrivals.atOf(card.link); // when the bundle of the card came in
```

- An inbound mark says at its `at` that the root of its bundle was on the
  user's devices, and a record that the object it links to was. `atOf` gives
  the earliest time at which a mark says so.
- Each mark says so as well of the objects in the closure of that root that
  are of the schema the view is made for, so a card that came inside a
  bundle has the time of that bundle. Any other blob of a closure has no
  time.
- What no mark says so of has no time either, such as an object written to
  the store with no record of it.
- The times are those the marks say, by the clocks of the user's devices,
  and not the order a store took its blobs in.

## Secret stores

Some objects are the user's alone, such as the secret key of a mailbox.
They are written to a `SecretStore`, which is kept beside a store, in a
backend of its own. Being secret is where an object is kept, not something
its schema says: an object of any schema can be kept on either side.

```ts
import { LinkValue, objectsOf } from "@estoc/object";
import { indexOver, MemoryBackend, SecretStore, Store, scan, selectedSecrets } from "@estoc/store";

const store = new Store(new MemoryBackend());
const secretStore = new SecretStore(store, new MemoryBackend());
await secretStore.write({ secrets: [key.link], blobs: [key.bytes, ...keySchema.blobs] });

for await (const link of secretStore.secrets()) …; // key.link
await secretStore.get(mailbox.link);               // from the store beside
await store.get(key.link);                         // undefined

// The key of each mailbox, from a `keyOfMailboxSchema` that links to both.
const byMailbox = indexOver(selectedSecrets(objectsOf(keySchema)), keyOfMailboxSchema, ({ link, data }) => [
  { mailbox: data.mailbox, key: new LinkValue(link) },
]).orderedBy("mailbox");
await scan(secretStore, byMailbox);
```

A secret store lists its secrets as they are, as a private store lists its
marks. `write` takes their links under `secrets` and their bytes among
`blobs`, and lists each, and `secrets()` gives their links in the order they
were first written. A secret is an
object of whatever schema its program gives it, and is a secret because the
secret store lists it: an object of the same schema that the store beside
holds is given by its link and is not listed.

The secret store reads the store beside it, so what it keeps can link to
what the store holds, and its `get` gives both. The store does not read the
secret store. A blob that only the secret store keeps is not one the
store holds, so the store refuses to write an object with one in its
closure, and its `get` and `closure` do not give one. A secret store has
no `closure` and is neither a `Store` nor a `PrivateStore`, so it cannot be
given to what gathers bundles, nor to what keeps marks. Being secret is
where bytes are kept, not a mark on them: bytes that are also written to the
store are the store's as well.

A write keeps each secret with the blobs of the batch in its closure, and
what the store beside holds counts as held: a blob that either side holds
need not come in the batch, and one that the store holds already is not kept
again. A secret that the store beside holds is listed here still. `scan` and
`view` take a secret store:

- An index over `selectedSecrets` reads its secrets, each as the object it
  is, and reads nothing from a store or a private store.
- An index over `selectedBlobs` reads only the blobs kept in it, which its
  `blobs` lists, so one that the store beside holds is read only by following
  a link.
- An index over `selectedMarks` or `selectedRecords` has no rows on it.

A secret store is only on the device that keeps it. Like a store, it only
grows, so a key that is no longer used is still kept. Whether it is
encrypted is up to its backend.

## Backends

A store keeps its blobs in a backend, and a private store or a secret store
its blobs and the list of its marks or of its secrets. A backend keeps bytes
and links as it is given them; the store does the hashing and decoding, of
what goes in and of what comes back. The list keeps the order in which links
were first listed, and a backend gives it from any point on, so a scan reads
only what was listed since the last one. A backend gives the links of its
blobs in the same way, which are the store's `blobs` and what it reads for an
index over blobs. `MemoryBackend` keeps them in memory, for tests and for a program that
keeps nothing once it ends.

`SqliteBackend` keeps them in one SQLite file. It runs only in Node, so it
is imported on its own, from `@estoc/store/sqlite`. Each write is one
transaction, which goes in whole or not at all and is on disk by the time
the write resolves. The file is not encrypted, so the file of a secret
store goes where only its user can read it.

```ts
import { SqliteBackend } from "@estoc/store/sqlite";

const backend = new SqliteBackend("store.db");
const store = new Store(backend);
// …
backend.close();
```

Stores are joined by writing bundles from one to another, not by copying
their files. A file copied while it is open, as by a tool that syncs a
folder, can come out damaged.
