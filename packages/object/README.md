# @estoc/object

Data written to a schema, encoded so that it has one byte string and one
link. An identity signs an object's link; what the data means comes from
its schema, and who has to sign is up to the application that reads it.

An object rests on an encoding, which writes each value of its data one
way, and a schema language over that encoding. This package writes objects
against what those two provide. It has one encoding, est, and no language
of its own: the one in use, Estoc Schema, is in `@estoc/schema` and is over
est. In that pair:

```
Link       LINK(h'<the SHA-256>'), wherever a value names a blob
Object     OBJECT([ <the link of its schema>, { ...<the fields of its data> } ])
Schema     an object whose data is { "title": <a string>, "fields": <the fields of its objects> }
```

A schema is an object too. It is written to the root schema of its
language, and the root schema is written to itself.

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
    and the link of its schema, and refuses any other value as an object.
    Any other value is bytes.
  - A blob cannot hold its own hash, so an encoding may have a mark for an
    object written to itself, in place of the link of its schema, as est
    has. The encoding gives the mark as `itself`, and `decodeObject` and
    `schemaOf` read it as the link of the blob, so every object they read
    names its schema by link. A root schema is such an object, so a
    language of schemas is over an encoding that has the mark.
  - The encoding finds the links in an object, so that the blobs in a
    blob's closure can be gathered without a schema to read it by, as a
    store gathers the closure it carries along with an object. Bytes link
    to nothing, whatever they hold, and an object written to itself does
    not link to itself.
- A `SchemaLanguage<D, S>` is a language of schemas over the data `D` of
  one encoding, which it names, with documents `S`. A schema is an object,
  so the language gives the data that a document is written as, and reads
  a document out of such data. It holds the document of its root schema,
  which its schemas are written to.
- A `SchemaValidator<D, S>` compiles the documents of one language, which
  it names, into checks of the fields of an object's data.

A validator names its language and a language names its encoding, so a
schema read with a validator knows the encoding of the objects written to
it: reading or writing an object takes the schema and nothing more. The
types tie them too: a language and its validators share the data type `D`
of the encoding. `schemaOf`, which reads the link of the schema an object
names before any schema is picked, is given the encoding.

An encoding is one object, shared by the languages over its data: a
language over est names `est`. Encodings are told apart as objects, so
schemas of two languages that both name `est` are schemas of one
encoding.

Two encodings of the same content are two blobs with two links, and
neither reads as the other, just as the same data under two schemas is two
objects. Moving to another encoding means writing new objects, not
translating old ones.

## Schemas

A schema is an object that other objects name by link. Its data is its
document, and it is written to the root schema of its language.

- What a schema holds is its language's to say: in Estoc Schema, a title
  and the fields of its objects.
- An object names its schema by link, and that is what makes the blob a
  schema to the object. A schema is reached from its objects.
- The root schema of a language is a schema of that language, written to
  itself. It says what the data of every schema of the language holds, its
  own included, so a schema is validated as any object is. What else
  makes a document one of the language is the language's to check, as
  whether a signature verifies is a verifier's to check and not its
  schema's.
- `rootSchemaOf(validator)` gives the root schema of the validator's
  language. A language has one, whichever validator compiles it.
- The root schema that a schema names says which language the schema is
  in. `decodeSchema` reads a schema with a validator, and refuses one that
  is written to another root schema than that of the validator's language.
  The encoding is the reader's to name: `schemaOf` is given it by its
  caller.
- A schema links to its root schema and to nothing else, and
  `decodeSchema` refuses one that links to another blob. A schema says
  that a field holds a link without holding one: in Estoc Schema the field
  is `{"type": "link"}`. So the closure of a schema is the schema and its
  root schema, which is what `blobs` of a `Schema` holds, and they go
  wherever an object of the schema goes, as into a store or a bundle.

The link of a schema fixes its bytes, and through its root schema the
language they are read in.

A blob that is not an object is bytes: an image, a ciphertext, or a JSON
file such as a `biome.json`. Only the links in an object are followed.

- In TypeScript a link is a `Link<T>` and the bytes of a blob are a
  `Bytes<T>`, `T` being what the blob is read as, so the compiler refuses the
  bytes of a signature handed to `decodeObject` with a schema whose data is
  declared otherwise. A link to a blob of no known kind, such as the object
  a signature is over, is a `Link<never>`, and reads as any. The type is a
  label, not a check: bytes read from a file or the network pass as any
  `Bytes<T>`, and decoding them is what checks them.
- Encoding goes through the same checks as decoding, so what is encoded here
  decodes again with the same validator.

## est

`est` is the Estoc Object Format: objects in deterministic CBOR
([RFC 8949, section 4.2.1](https://www.rfc-editor.org/rfc/rfc8949#section-4.2.1)).
It is the encoding in use: the schema language of `@estoc/schema` is over
it, and the other packages write their objects in it.

```
OBJECT([ LINK(h'…'),               the schema of the object
         { "text": "hello" } ])    the fields of its data
```

The 55 bytes of that object:

```
da 65 73 74 3f            the tag of the format, "est?" in ASCII
82                        an array of two
   d9 48 6c               tag 18540, a SHA-256 hash value: here, a link
   58 20 …                the 32 bytes of the SHA-256 of the schema
   a1                     a map of one field
      64 74 65 78 74      "text"
      65 68 65 6c 6c 6f   "hello"
```

- A blob of est is one object: the tag of the format around an array of
  two, the schema of the object and the map of its fields. The schema is
  named by its place, so the data may hold a field of any name. est has no
  value that is not an object: any other bytes are refused, and are a blob
  of bytes, which links to nothing.
- A value in data is of one of seven kinds: an integer, bytes, a string, a
  boolean, an array, a map by string keys, or a link. Floats, null, other
  tags and an object inside data are refused. In TypeScript the seven are a
  number, a `Uint8Array`, a string, a boolean, an array, a plain object and
  an `EstLink<T>`, which `new EstLink(link)` makes and whose `link` is the
  `Link<T>`.
- Integers are up to 2^53 − 1 in magnitude, which a number holds exactly.
- Decoding is strict: the bytes must be exactly what the encoding writes
  for the value they hold. Heads longer than the shortest, keys of a map
  out of the order of their bytes or repeated, indefinite lengths, invalid
  UTF-8, and bytes after the object are refused.
- A link is tag 18540 around the 32 bytes of a SHA-256. IANA lists the tag
  as a SHA-256 hash value, and est reads one in an object as a link. The
  links the encoding finds in an object are the ones under the tag, at any
  depth, its schema among them, and no others. A hash that names no blob
  to follow is written as bytes, and a string is a string whatever it
  holds. The tags of other hashes are refused, so that a blob has one
  link.
- An object written to itself names its schema by the string `"self"` in
  place of a link, and any other string there is refused. It reads back
  with its own link as its schema, so it is refused as an object of any
  other schema. The root schema of a language is written so.
- Every object starts with the same six bytes, `da 65 73 74 3f 82`. Unless
  it is written to itself, the next five are the same too, and the hash of
  its schema follows them, at byte 11.
- A blob does not say which version of the format it is in. Another
  encoding would be written under another tag.

## Objects

An object holds its data and the link of its schema, and nothing else, and
its data has to fit the schema. The schema checks the data alone, and the
link of the schema is no field of it, so a schema that takes no fields
beyond its own still takes the object. Reading one takes the schema
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
there, as in `const login: Schema<Est, Login> = decodeSchema(bytes,
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

- A schema holds all that its data is checked against. It links to its
  root schema and to nothing else, and compiling it fetches nothing, so
  the link of a schema fixes what its objects may hold, and no one changes
  that later by changing what a URL names.
- What fits a schema is the language's to say. Estoc Schema leaves nothing
  to a validator, so the same schema and data get the same answer from any
  of them. Where a language leaves something open, a signature commits to
  bytes and a validator is one reading of them, so a stricter validator can
  replace another without any blob changing.
- A validator reads the schemas of one language, and a schema written to
  the root schema of another is refused rather than read by other rules.

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

const plainText: Implementation<Est, Text, { readonly text: string }> = {
  schema: plain,
  read: ({ link, data }) => ({ link, text: data.text }),
};
const quotedText: Implementation<Est, Text, { readonly quotes: EstLink<Text> }> = {
  schema: quote,
  async read({ link, data }, reader) {
    const quoted = await texts.read(data.quotes.link, reader);
    return { link, text: `"${quoted.text}"` };
  },
};
const texts = new Implementations(est, [plainText, quotedText]);
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
type Reply = { readonly to: EstLink<unknown>; readonly text: string };
type ReplyToNote = { readonly reply: EncodedObject<Est, Reply>; readonly note: EncodedObject<Est, Note> };

const repliesToNotes = new SelectionBySchema<Est, ReplyToNote, Reply>(replySchema, async (reply, reader) => {
  const bytes = await reader.get(reply.data.to.link);
  if (bytes === undefined || schemaOf(bytes, est) !== noteSchema.link) return undefined;
  return { reply, note: decodeObject(bytes, noteSchema) };
});
```

Any other selection reads the record itself, with the schemas it chooses,
as an implementation table does, and is handed every record. The indexes of
`@estoc/store` are built over selections.
