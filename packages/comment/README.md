# @estoc/comment

A comment says something about a blob. It is an object the user writes,
and links to the blob it is on, which can be any blob: an object, a schema,
a file, or another comment. A store, read through a catalog of
`@estoc/store` and with comments on what it holds, is then a database of
hashes: what the user wrote, listed by the schema each object names, what
each hash holds, and what the user said about it.

```
Comment  {"on": <link of the blob>, "text": <what it says>, "at": <milliseconds>}
```

## Comments

`at` is when the comment was written, in milliseconds since the Unix epoch
by the clock of the device that wrote it, so the same words said twice are
two comments. `text` is not empty, and no other field is allowed.

A comment links to what it is on, so a store refuses a comment on a blob it
does not hold, and whatever holds a comment holds what it is on: the
closure of a comment, and so a bundle of one, carries the blob along with
it. A reply is a comment on a comment.

A comment does not say who wrote it. Written to the user's store, it is
theirs; one that is to travel is signed, as any object is, and the reader
reads who wrote it from the signature.

```ts
import { defaultValidator } from "@estoc/object/default-validator";
import { loadComments } from "@estoc/comment";

const comments = await loadComments({ validator: defaultValidator });
const comment = await comments.write(store, object.link, "noon is too early");
await comments.write(store, comment.link, "it is not");
```

`write` writes the comment to the store as the user's, with its schema, and
gives it back. The store may be a `PrivateStore`, for a comment the user
keeps to themselves. `encode` gives the object without writing it, and
`read` reads a comment by its link from any reader, such as a bundle, and
refuses an object of any other schema.

## Reading by what they are on

`index` is an index of the comments the user wrote, a row
`[on, at, comment]` for each, and `view` reads them back by the blob each
is on:

```ts
import { view } from "@estoc/store";

const commentary = await view(store, comments.view);
await commentary.on(object.link);         // the comments on it, oldest first
for await (const link of commentary.commented()) …;  // each blob commented on, once
```

The comments on a blob come oldest first, and those written at the same
time in the order of their links. As with any index, only what the user
wrote is listed: a comment that came in a bundle from someone else is not
among them, and is read by following links from the record of receiving
it, with the signature of whoever wrote it.

## A database of hashes

The catalog lists the user's objects by the schema each names; a blob's
bytes are got by its link and read without a schema; and a comment can be
on any of them.

```ts
import { json, schemaOf } from "@estoc/object";
import { catalog } from "@estoc/store";

const rows = await catalog(store, json);
for await (const [schema, object] of rows.range([noteSchema.link])) …;  // the notes

const bytes = await store.get(object);
json.decode(bytes);                                // what the hash holds
json.decode(await store.get(schemaOf(bytes, json)));  // and its schema

await comments.write(store, object, "lunch moved to one");
```

Comments are objects the user writes, so they are in the catalog too,
under the schema of a comment.
