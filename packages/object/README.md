# @estoc/object

Data written to a schema, encoded so that it has one byte string and one
link. An identity signs an object's link; what the data means comes from
its schema, and who has to sign is up to the application that reads it.

An object rests on an encoding, which writes each value of its data one
way, and a schema language over that encoding. This package writes objects
against what those two provide. It has one encoding, JSON with JCS, and no
language of its own: the one in use, Estoc Schema, is in `@estoc/schema`.
In that pair:

```
Link       {"$link": "sha256:<hex>"}, wherever a value names a blob
Object     {"$schema": <the link of its schema>, ...<the fields of its data>}
Schema     {"title": <a string>, "fields": <the fields of its objects>}
```

A schema is not an object. It is bytes, as every blob that is not an
object is, and the objects that name it are what make it a schema.

The encodings, objects, schemas and validators are the substrate that every
application shares, and they give an object no meaning. Identities, and the
signatures by which they stand behind objects, are in `@estoc/identity`.

## Encodings and schema languages

- A blob's link is `sha256:` followed by the SHA-256 of its bytes in
  lowercase hex, whatever the bytes are.
- An `Encoding<D>` is a model of data `D` and the one way each value is
  written as bytes.
  - Decoding refuses any bytes but those the encoding writes for the value
    they hold, so that a value has one encoding and one link.
  - Decoding needs no schema, so that the schema an object names can be read
    before the schema is.
  - The data of an object is fields, values of the encoding by name
    (`Fields<D>`). The encoding writes an object as one value, those fields
    and one more for the link of its schema, and refuses any other value as
    an object. Any other value is bytes.
  - The encoding finds the links in an object, so that the blobs in a
    blob's closure can be gathered without a schema to read it by, as a
    store gathers the closure it carries along with an object. Bytes link
    to nothing, whatever they hold.
- A `SchemaLanguage<D, S>` is a language of schemas over the data `D` of
  one encoding, which it names, with documents `S`. It writes a document
  as a value of the encoding, and reads a schema's document out of one.
- A `SchemaValidator<D, S>` compiles the documents of one language, which
  it names, into checks of the fields of an object's data.

A validator names its language and a language names its encoding, so a
schema read with a validator knows the encoding of the objects written to
it: reading or writing an object takes the schema and nothing more. The
types tie them too: a language and its validators share the data type `D`
of the encoding. `schemaOf`, which reads the link of the schema an object
names before any schema is picked, is given the encoding.

An encoding is one object, shared by the languages over its data: a
language over JSON names `json`. Encodings are told apart as objects, so
schemas of two languages that both name `json` are schemas of one
encoding.

Two encodings of the same content are two blobs with two links, and
neither reads as the other, just as the same data under two schemas is two
objects. Moving to another encoding means writing new objects, not
translating old ones.

## Schemas

A schema is bytes: a value of its encoding that is not an object, and so
names no schema of its own.

- What a schema holds is its language's to say: in Estoc Schema, a title
  and the fields of its objects.
- An object names its schema by link, and that is what makes the bytes a
  schema. A schema is reached from its objects, and no schema describes a
  schema: an object is written to a schema, and a schema to nothing.
- No blob says which language a schema is in. The program that reads one
  names the language, by the validator it reads with. An encoding is told
  the same way: no blob says that some bytes are JCS, and `schemaOf` is
  given the encoding by its caller.
- A schema links to nothing, as bytes link to nothing whatever they hold,
  and an object, which links to its schema, is refused as a schema. A
  schema says that a field holds a link without holding one: in Estoc
  Schema the field is `{"type": "link"}`. So the closure of a schema is
  the schema alone, and its `bytes` go wherever an object of it goes, as
  into a store or a bundle.

The link of a schema fixes its bytes, and not the language they are read
in. Programs that share objects share the language, as they share the
encoding.

A blob that is not an object is bytes: a schema, an image, or a JSON file
such as a `biome.json`, whose `$schema` is a string, even when it happens
to be JCS. Only the links in an object are followed.

- In TypeScript a link is a `Link<T>` and the bytes of a blob are a
  `Bytes<T>`, `T` being what the blob is read as, so the compiler refuses the
  bytes of a signature handed to `decodeObject` with a schema whose data is
  declared otherwise. A link to a blob of no known kind, such as the object
  a signature is over, is a `Link<never>`, and reads as any. The type is a
  label, not a check: bytes read from a file or the network pass as any
  `Bytes<T>`, and decoding them is what checks them.
- Encoding goes through the same checks as decoding, so what is encoded here
  decodes again with the same validator.

## JSON

`json` is the encoding of this package. The schema language over it is in
`@estoc/schema`.

- `json` writes a JSON value as its JCS
  ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)) encoding, in UTF-8.
- Decoding is strict: the bytes must be exactly the JCS encoding of the value
  they hold. Invalid UTF-8, a byte order mark, whitespace, keys out of order
  or repeated, needless escapes, and numbers not written the shortest way
  (`1.0`, `1e2`, `-0`, `1152921504606846977`) are refused, as JCS itself
  refuses lone surrogates, NaN and Infinity. Apart from the rule on `$link`
  below, there are no further rules on the JSON.
- Numbers are IEEE 754 doubles, written as JCS writes them: 2^60 as
  `1152921504606847000`, 10^21 as `1e+21`. Integers up to 2^53 − 1 in
  magnitude are exact in every language; write larger integers and decimal
  amounts as strings when they have to be exact.
- A link is the JSON object `{"$link": "sha256:<hex>"}`, with no other
  member. JSON has no type for a link, so this marks one wherever a value
  names a blob, as tag 42 does in CBOR, and a string is a string whatever
  it holds. Any other object with a `$link` member is refused, in writing
  and in reading, whether it holds something other than a link or a member
  beside it, so whatever has the mark of a link is one. That holds for
  schemas as well, which are JSON too. The links the
  encoding finds in an object are the ones these hold, its schema among
  them, and no others; in bytes it finds none. In TypeScript a link in JSON data is a
  `JsonLink<T>`, `{ $link: Link<T> }`.
- An object is the JSON object of the fields of its data and `$schema`,
  which holds the link of its schema. Only there does `$schema` name a
  schema: deeper in the data it is a field like any other, and data with a
  `$schema` of its own is refused. JSON without a `$schema` that is a link
  is bytes.
- A schema is JSON that is not an object. What it holds is the language's:
  the schemas of Estoc Schema are in the README of `@estoc/schema`.
- A blob does not say what kind of blob it is, or which version of the
  format. A reader knows which kind it expects. An object names its
  schema, so it cannot pass for an object of another, and a signature is
  an object like any other. A schema names nothing: it is read as one
  where an object names it, in the language the reader names.
- `json.encode` and `json.decode` are this encoding on its own, for formats
  built on it that are not objects.

## Objects

An object holds its data and the link of its schema, and nothing else, and
its data has to fit the schema. The schema checks the data alone, without
`$schema`, so it does not name the field, and a schema that takes no
fields beyond its own still takes the object. Reading one takes the schema
the reader expects and refuses an object written to any other, so an
application does not mistake another schema's object for one of its own.
The same value under two schemas is two objects.

```ts
import { decodeObject, encodeObject } from "@estoc/object";
import { schema, string } from "@estoc/schema";

const login = schema("Login", { audience: string(), nonce: string() });
const object = encodeObject(login, { audience: "https://app.estoc.dev", nonce: "6f1c0a9e" });
decodeObject(object.bytes, login).data.nonce; // "6f1c0a9e"
```

A schema carries the type a program reads its data as, `Schema<D, F>`, and
the data of an object of that schema is an `F`. `schema` works the type out
from the fields. A program that gets a schema another way declares the type
there, as in `const login: Schema<Json, Login> = decodeSchema(bytes,
schemaValidator)`. Either way the type is the program's claim, and checking
the data against the schema is what holds it: data that does not fit is
refused, not handed out as an `F`. The data of a schema declared with no
type is fields of the encoding.

`readObject` reads the object that a link names from a `Reader`: anything
with `get(link)` that gives the bytes at once or as a promise, such as a
`Map`, a bundle or a store. A reader gives under a link only the blob that
the link names, or nothing: a bundle checks its blobs when it is made, a
store hashes what it gets back from where it keeps them, and a `Map` holds
what was filed in it by `linkOf`. So what reads from a reader, such as a
verifier that looks at an object's schema before choosing how to read it,
takes the bytes as the blob of the link. `readObject` fails when the reader
gives no blob, and refuses one whose bytes have another link all the same,
since decoding them gives their link anyway.

## Validators

A validator compiles a schema's document into a check once, when the schema
is read, and the schema keeps the check. None of that waits for anything:
`encodeSchema`, `decodeSchema` and `decodeObject` are synchronous, so a
schema can be a constant of a module, and `readObject` returns a promise
only because the reader it gets the blob from may answer with one.

What a check may turn on follows from how schemas and languages are built:

- A schema holds all that its data is checked against. It links to
  nothing, and compiling it fetches nothing, so in one language the link
  of a schema fixes what its objects may hold, and no one changes that
  later by changing what a URL names.
- What fits a schema is the language's to say. Estoc Schema leaves nothing
  to a validator, so the same schema and data get the same answer from any
  of them. Where a language leaves something open, a signature commits to
  bytes and a validator is one reading of them, so a stricter validator can
  replace another without any blob changing.
- A validator reads the schemas of one language, and bytes that are not a
  schema of it are refused rather than read by other rules.

## Verifiers

A schema says what the data of an object may hold, and no more. A verifier
checks the rules it cannot say, such as whether a signature verifies, from
an object and what it links to, each time the object is read. A verifier
takes the object it verifies, already validated against its schema, and a
`Reader`, and reads by link the other objects it needs when it comes to
them. It gives the object together with what it found, as a verified
signature comes with the identity that made it, and only the verifier
makes such a value, so a program holding one holds an object that passed.
A verifier that starts from the link of the object takes the link and the
reader instead, as `signatures.read` does. One that also turns on what the
program has seen besides takes that too, as `signatures.read` takes the
identity versions the program has seen. The verifiers of identities and
signatures are in `@estoc/identity`.

A program reads objects of the schemas it expects, with the type it
declares for each, and verifies those that need it. Which schemas those are
is the program's to say, and not anything an object or a schema says of
itself. A program that takes objects of several schemas, such as a
transport for each kind of mailbox, or an identity in each scheme, reads
the link of the schema an object names with `schemaOf`, given the encoding
the object is in, and picks by it the schema to read the object with.

Reading an object does not write it again, so what a program makes of it
can keep its link, and the signatures over the object still apply. Written
again to another schema, the same content would be another object, which
no one has signed.

A schema is named by its link, so a schema that changes is another schema.
A program's own newer schema, its older one and another application's are
then alike: each is one more schema for the program to read, and keeping
up with one's own past is the same work as reading another application.

## Implementations

Where a program reads objects of several schemas as one kind of thing, as
`@estoc/identity` reads a key in any of its schemes as a key, that kind is
an interface. What a schema's objects read as is the program's to say, not
the schema's: one program reads an Ed25519 key as a key, another could
read the same key as a Solana address. So a schema does not name an
interface. A program lists the concrete schemas it reads as one, each with
how its data becomes the interface's shape, and picks among them by
`schemaOf`.

That list is `Implementations`. Each `Implementation` is a compiled schema
with a `read` that turns an object written to it into the interface's
shape, following what the object links to through the reader. The table
reads an object by its link with the implementation of the schema it
names, and refuses one written to any other schema. Here `plain` and
`quote` are two schemas of one interface, and an object of `quote` links to
the text it quotes:

```ts
type Text = { readonly link: Link<unknown>; readonly text: string };

const plainText: Implementation<Json, Text, { readonly text: string }> = {
  schema: plain,
  read: ({ link, data }) => ({ link, text: data.text }),
};
const quotedText: Implementation<Json, Text, { readonly quotes: JsonLink<Text> }> = {
  schema: quote,
  async read({ link, data }, reader) {
    const quoted = await texts.read(data.quotes.$link, reader);
    return { link, text: `"${quoted.text}"` };
  },
};
const texts = new Implementations(json, [plainText, quotedText]);
await texts.read(link, reader); // a Text, whichever of the two schemas the object names
```

The table takes the shape from its implementations, so it is not named
again. `implementationOf` gives the implementation of a schema, for what a
program does with objects of it beyond reading them. Its `read` takes an
object already read with that schema, as the table's `read` gives it.

## Selections

A program does not always take every object of a schema, nor only objects
of one. A `Selection` says which records it takes and what each one reads
as: `read` reads the record that a link names, and what it links to, from
the reader, and gives what the record reads as, or `undefined` for one it
leaves out. Whether it takes a record depends on the record and its
closure alone, so it takes the same records whatever else the program has
read.

Most selections take objects of one schema, and a `SelectionBySchema` is
one of those: it is given the schema, and what an object read with it reads
as. Reading a record with it comes to reading the object first, so what
reads records with several selections can read each record with a schema
once, and pass over records of other schemas. `objectsOf(schema)` takes
every object of `schema`, each as itself. One schema can then hold objects
of several kinds, told apart by what they link to. Here a reply of
`replySchema` can answer any object, and the selection takes the replies
that answer a note of `noteSchema`, each with the note:

```ts
type Reply = { readonly to: JsonLink<unknown>; readonly text: string };
type ReplyToNote = { readonly reply: EncodedObject<Json, Reply>; readonly note: EncodedObject<Json, Note> };

const repliesToNotes = new SelectionBySchema<Json, ReplyToNote, Reply>(replySchema, async (reply, reader) => {
  const bytes = await reader.get(reply.data.to.$link);
  if (bytes === undefined || schemaOf(bytes, json) !== noteSchema.link) return undefined;
  return { reply, note: decodeObject(bytes, noteSchema) };
});
```

Any other selection reads the record itself, with the schemas it chooses,
as an implementation table does, and is handed every record. The indexes of
`@estoc/store` are built over selections.
