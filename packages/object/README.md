# @estoc/object

Data written to a schema, encoded so that it has one byte string and one
link. An identity signs an object's link; what the data means comes from
its schema, and who has to sign is up to the application that reads it.

An object rests on an encoding, which writes each value of its data one
way, and a schema language over that encoding. This package writes objects
against what those two provide, and has one pair of them: JSON with JCS,
and JSON Schema. In that pair:

```
Link       {"$link": "sha256:<hex>"}, wherever a value names a blob
Schema     a JSON Schema document: a JSON object naming its dialect in $schema
Object     {"$describedBy": <the Schema's link>, ...<the fields of its data>}
```

The encodings, objects, schemas and validators are the substrate that every
application shares, and they give an object no meaning. Identities, and the
signatures by which they stand behind objects, are in `@estoc/identity`.

## Encodings and schema languages

- A blob's link is `sha256:` followed by the SHA-256 of its bytes in
  lowercase hex, whatever the bytes are.
- An `Encoding<D>` is a model of data `D` and the one way each value is
  written as bytes. Decoding refuses any bytes but those the encoding writes
  for the value they hold, so that a value has one encoding and one link,
  and it needs no schema, so that the schema an object names can be read
  before the schema is. The data of an object is fields, values of the
  encoding by name (`Fields<D>`), and the encoding writes an object as one
  value, those fields and one more for the link of its schema, and refuses
  any other value as an object. And it finds the links in a value, so that
  what a blob leads to can be gathered without a schema to read it by, as a
  store gathers what it carries along with an object.
- A `SchemaLanguage<S, D>` is a language of schemas `S` that describe the
  data of one encoding, which it names. A schema is a blob of its own, with
  one way of being written and a link.
- A `SchemaValidator<S, D>` compiles the schemas of one language, which it
  names, into checks of the fields of an object's data.

A validator names its language and a language names its encoding, so a
schema read with a validator knows the encoding of the objects written to
it: reading or writing an object takes the schema and nothing more. The
types tie them too: a language and its validators share the data type `D`
of the encoding. `schemaOf`, which
reads the link of the schema an object names before any schema is picked,
is given the encoding.

An encoding is one object, shared by the languages over its data: a
language over JSON names `json`. Encodings are told apart as objects, so
schemas of two languages that both name `json` are schemas of one
encoding.

Two encodings of the same content are two blobs with two links, and
neither reads as the other, just as the same data under two schemas is two
objects. Moving to another encoding means writing new objects, not
translating old ones.

- In TypeScript a link is a `Link<T>` and the bytes of a blob are a
  `Bytes<T>`, `T` being what the blob is read as, so the compiler refuses the
  bytes of a signature handed to `decodeObject` with a schema whose data is
  declared otherwise. A link to a blob of no known
  kind, such as the object a signature is over, is a `Link<never>`, and
  reads as any. The type is a label, not a check: bytes read from a file or
  the network pass as any `Bytes<T>`, and decoding them is what checks them.
- Encoding goes through the same checks as decoding, so what is encoded here
  decodes again with the same validator.

## JSON

`json` is the encoding of this package, `jsonSchema` the schema language
over it, and `defaultValidator` a validator of that language.

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
  schemas as well, which are JSON too. The links the encoding finds in a
  value are the ones these objects hold, the schema an object names among
  them, and no others. In TypeScript a link in JSON data is a
  `JsonLink<T>`, `{ $link: Link<T> }`.
- An object is the JSON object of the fields of its data and
  `$describedBy`, which holds the link of its schema. Only there does
  `$describedBy` name a schema: deeper in the data it is a field like any
  other, and data with a `$describedBy` of its own is refused. A schema is
  a JSON object naming its dialect in `$schema`, written as JSON is, and
  has no `$describedBy`.
- A blob does not say what kind of blob it is, or which version of the
  format. A reader knows which kind it expects, and the kinds cannot pass
  for one another: an object has `$describedBy`, and a schema has
  `$schema` and no `$describedBy`. A signature is an object, and like any
  object it cannot pass for one of another schema.
- `json.encode` and `json.decode` are this encoding on its own, for formats
  built on it that are not objects.

## Objects

An object holds its data and the link of its schema, and nothing else, and
its data has to fit the schema. The schema checks the data alone, without
`$describedBy`, so it does not name the field, and a schema that takes no
fields beyond its own still takes the object. Reading one takes the schema
the reader expects and refuses an object written to any other, so an
application does not mistake another schema's object for one of its own.
The same value under two schemas is two objects.

```ts
import { decodeObject, encodeObject, encodeSchema, type Json, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";

type Login = { readonly audience: string; readonly nonce: string };

const login: Schema<Json, Login> = await encodeSchema(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { audience: { type: "string" }, nonce: { type: "string" } },
    required: ["audience", "nonce"],
    additionalProperties: false,
  },
  defaultValidator,
);
const object = encodeObject(login, { audience: "https://app.estoc.dev", nonce: "6f1c0a9e" });
decodeObject(object.bytes, login).data.nonce; // "6f1c0a9e"
```

A schema carries the type a program reads its data as, `Schema<D, F>`. The
program declares it where it gets the schema, as `login` is declared above,
and the data of an object of that schema is an `F`. The declaration is the
program's claim, and checking the data against the schema is what holds it:
data that does not fit is refused, not handed out as an `F`. The data of a
schema declared with no type is fields of the encoding.

`readObject` reads the object that a link names from a `Reader`: anything
with `get(link)` that gives the bytes at once or as a promise, such as a
`Map`, a bundle or a store. A reader gives under a link only the blob that
the link names, or nothing: a bundle checks its blobs when it is made, a
store hashes what it gets back from where it keeps them, and a `Map` holds
what was filed in it by `linkOf`. So what reads from a reader, such as a
judgment that looks at an object's schema before choosing how to read it,
takes the bytes as the blob of the link. `readObject` fails when the reader
gives no blob, and refuses one whose bytes have another link all the same,
since decoding them gives their link anyway.

A schema holds all that its data is checked against. In JSON Schema a `$ref`
reaches the schema's own parts and nothing elsewhere, so the link of a
schema fixes what its objects may hold, and no one changes that later by
changing what a URL names. Where the data holds a link, the schema writes
out what a link looks like: `linkSchema`, to place there, takes an object
whose one member is `$link`, a string matching `^sha256:[0-9a-f]{64}$`. It
names the member through `propertyNames` rather than `properties`, since
`{"properties": {"$link": …}}` would itself be an object with a `$link`
member that is not a link.

## Validators

Whether a value fits a schema is the validator's call. A validator compiles a
schema once, when the schema is read, and the schema keeps the result, so
reading a schema returns a promise and checking an object against it does
not: `decodeObject` is synchronous, and `readObject` returns a promise only
because the reader it gets the blob from may answer with one. Every
validator works offline and keeps to three rules:

- A reference to anything outside the schema fails compilation, rather than
  the validation that happens to reach it.
- The same schema and value give the same answer every time.
- A version of the language it does not support fails compilation.

For JSON Schema, a reference is a `$ref`, and one in a place the dialect
ignores, such as under `then` without `if`, has no effect; a version is a
dialect. Anything else, such as whether `format` is asserted or which
regular expression dialect `pattern` uses, is the validator's own. A
signature commits to bytes, so a stricter validator can replace another
without any blob changing.

`defaultValidator`, from `@estoc/object/default-validator`, wraps
[`@hyperjump/json-schema`](https://www.npmjs.com/package/@hyperjump/json-schema),
which interprets schemas instead of generating code and so runs under a
strict content security policy. It takes draft 2020-12 only, in the schema
and in any schema resource inside it. A schema without `$id` can reference
its own parts by fragment (`#/$defs/name`), and a schema resource inside it
by its `$id`. Nothing is fetched, so a URL resolves only to a part of the
schema itself, and not to the draft's meta-schemas either.
It asserts the formats hyperjump's lite set knows (dates, times and
durations, email, IP addresses, URIs and IRIs, UUIDs, URI templates, JSON
pointers and regular expressions) and passes the rest.

hyperjump keeps one schema registry and one configuration for a JavaScript
realm. Importing the default validator turns off hyperjump's fetching over
http, https and file URLs and turns on format assertion for the realm, and
the default validator compiles one schema at a time so that schemas do not
see each other in the registry. Code in the same realm that configures
hyperjump otherwise, or adds formats to it, changes the default validator's
answers; such an application is better off with a validator of its own.

A `pattern` can backtrack exponentially in the length of the string it
tests. Pinning a schema keeps out patterns someone else wrote, but not data
that sets off one of the application's own: under a pinned `^(a+)+$`, about
thirty characters stall validation for seconds. Validate untrusted objects in
a worker with a time limit, unless the schema's patterns and the length of
the strings they test have been reviewed to keep validation cheap. A viewer
of arbitrary objects, which also runs schemas someone else wrote, needs the
worker in any case.

## Judgments

A schema says what the data of an object may hold, and no more. The rules
it cannot say, such as whether a signature verifies, are judgments: worked
out from an object and what it links to, each time the object is read. A
judgment takes the object it judges, already checked against its schema,
and a `Reader`, and reads by link the other objects it needs when it comes
to them. It gives the object together with what it found, as a verified
signature comes with the identity that made it, and only the judgment
makes such a value, so a program holding one holds an object that passed.
A judgment that starts from the link of the object takes the link and the
reader instead, as `signatures.read` does. The judgments of identities and
signatures are in `@estoc/identity`.

A program reads objects of the schemas it expects, with the type it
declares for each, and judges those that need it. Which schemas those are
is the program's to say, and not anything an object or a schema says of
itself. A program that takes objects of several schemas, such as a
transport for each kind of mailbox, or an identity in each scheme, reads
the link of the schema an object names with `schemaOf`, given the encoding
the object is in, and picks by it the schema to read the object with.

Reading an object does not write it again, so what a program makes of it
can keep its link, and the signatures over the object still apply. Written
again to another schema, the same content would be another object, which
no one has signed.

## Interfaces

Where a program reads objects of several schemas as one kind of thing, as
`@estoc/identity` reads a key in any of its schemes as a key, that kind is
an interface, and each of those schemas can name it. In JSON Schema a
schema names it by `"x-implements": {"$link": <link>}`, the link of a blob
that stands for the interface, such as its name as text. One schema names
one interface.

- JSON Schema has no keyword for this. `allOf` with a `$ref` says that the
  data also fits another schema, which is about shape, not kind, and a
  `$ref` reaches nothing outside the schema anyway. Keywords that start
  with `x-` are left to annotations of one's own, and later drafts do not
  take the names. In draft 2020-12 a keyword the dialect does not know
  has no effect on validation, and an implementation that collects
  annotations can report its value; `JsonSchemaValidator` reports only
  what does not fit, so here the mark is read from the schema itself.
- The value is a link, not a string, so a store or a bundle that follows a
  schema's links carries the interface along with it, and whoever holds
  the schema holds the interface too. An object's closure includes it,
  and a batch written to a store has to carry it.
- A schema has no `$describedBy`, so the mark goes in a keyword of its own
  rather than there.

The mark does not let a program take a schema it does not know. A program
still pins the concrete schemas it reads, each with how its data becomes
the interface's shape, and picks among them by `schemaOf`. What the mark
adds is that the schemas themselves say what the program's table says,
which a test can hold the two to.
