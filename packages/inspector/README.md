# @estoc/inspector

What a link reads as, by what the blob says of itself. `inspect` gets the
blob that a link names from a reader, and gives its fields, the schema it
names and the links in its data.

```ts
import { inspect } from "@estoc/inspector";

const inspection = await inspect(link, store);
if (inspection.kind === "object") {
  inspection.data;   // { text: "a note", replies: [LinkValue] }
  inspection.links;  // [{ path: "#/replies/0", link: "sha256:…" }]
  inspection.schema; // { kind: "schema", link, document: { title: "Note", fields: … }, problems: [] }
}
```

The reader is any `Reader` of `@estoc/object`: a store, a bundle, a `Map`
of blobs, or several of them that the caller has put behind one `get`.

## Reading without a schema in hand

A program reads an object with the schema it expects, and refuses an
object written to any other: that is `readObject`. `inspect` goes the
other way. It has no schema of its own, and reads an object by the schema
the object names.

So all that an inspection holds is what the blob says of itself:

- The title is the one the schema gave itself. Anyone can write a schema
  titled `Identity`.
- Data that fits its schema has the right shape, and no more is said by
  it. Whether a signature verifies is for a verifier to say.
- That a reader gives a blob says the blob came to it. Whose the object
  is, and whether it is a record, is for what lists it to say.

A program that has schemas of its own matches them by the link of the
schema, which an inspection gives, and not by the title.

## What an inspection holds

Reading goes one step at a time. Each step stops on its own, and what was
read before it is still given.

| step                             | where it stops                                                |
| -------------------------------- | ------------------------------------------------------------- |
| the reader gives the blob        | `kind: "absent"`, with the link alone                         |
| the blob is an object            | `kind: "bytes"`, with the bytes                               |
| the schema it names is a schema  | `kind: "object"`, with `schema.kind` `"absent"` or `"refused"` |
| its data fits the schema         | `kind: "object"`, with `schema.problems` listing what does not |

- Bytes that are not an object of the Estoc Object Format are a blob of
  bytes that links to nothing, as they are to the format.
- An object gives its `data` whatever comes of its schema: the object
  format marks the type of every value, so the fields are read without one.
- `schema.kind` is `"absent"` when the reader gives no blob for the schema
  the object names, and `"refused"` when the blob it gives is not a schema
  of Estoc Schema, with the `error` that says why. Otherwise it is
  `"schema"`, with the `document` of the schema, its title and fields.
- `schema.problems` is what the validator of `@estoc/schema` lists, each
  with its place in the data, as in `#/replies/1: not a link`. An empty
  list means the data fits.
- An object written to itself names itself as its schema. For the root
  schema that reads as a schema; for any other object it is refused.

## Links

`links` holds each link in the data with its `path`, the place of the link
in the data, spelled as the validator spells the place of a problem: `#`,
then the name of each field or member and the index of each item on the
way, as in `#/replies/0`. They come in the order the bytes hold them,
which is the order the object format puts the members of a map in and not
the order they were written in.

The schema an object names is given apart, under `schema`, and is not
among `links`.

A link is followed by inspecting it through the same reader. Nothing is
followed until it is asked for, so inspecting an object reads two blobs
at most, the object and its schema, however much it links to.
