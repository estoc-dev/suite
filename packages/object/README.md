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
Object     {"data": <any JSON value>, "schema": <the Schema's link>}
Identity   an Object written to the identity schema, with the data
           {"publicKey": <hex>, "scheme": <scheme>}
Signature  an Object written to the signature schema, with the data
           {"identity": <the Identity's link>, "object": <the Object's link>, "signature": <hex>}
```

The encodings, objects, schemas and validators are the substrate that every
application shares. Semantics are how a program reads objects as values of
its own types. The semantics of identities and signatures are kept in this
package because the packages built on it sign and name identities; another
application can read the same objects without them.

## Encodings and schema languages

- A blob's link is `sha256:` followed by the SHA-256 of its bytes in
  lowercase hex, whatever the bytes are.
- An `Encoding<D>` is a model of data `D` and the one way each value is
  written as bytes. Decoding refuses any bytes but those the encoding writes
  for the value they hold, so that a value has one encoding and one link,
  and it needs no schema, so that the schema an object names can be read
  before the schema is. The encoding also writes an object, its data and
  the link of its schema, as one value, and refuses any other value as an
  object.
- A `SchemaLanguage<S, D>` is a language of schemas `S` that describe the
  data of one encoding, which it names. A schema is a blob of its own, with
  one way of being written and a link.
- A `SchemaValidator<S, D>` compiles the schemas of one language, which it
  names, into checks of data `D`.

A validator names its language and a language names its encoding, so a
schema read with a validator knows the encoding of the objects written to
it: reading or writing an object takes the schema and nothing more. The
types tie them too: a language and its validators share the data type `D`
of the encoding, and so do the readings of one semantics. `schemaOf`, which
reads the link of the schema an object names before any schema is picked,
is given the encoding.

An encoding is one object, shared by the languages over its data: a
language over JSON names `json`. A semantics tells encodings apart as
objects, so it reads schemas of two languages together when both name the
same encoding.

Two encodings of the same content are two blobs with two links, and
neither reads as the other, just as the same data under two schemas is two
objects. Moving to another encoding means writing new objects, not
translating old ones.

- In TypeScript a link is a `Link<T>` and the bytes of a blob are a
  `Bytes<T>`, `T` being what the blob is read as, so the compiler refuses the
  bytes of a signature handed to `decodeObject` rather than to
  `signatures.decode`, which verifies them. A link to a blob of no known
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
  schemas as well, which are JSON too. In TypeScript a link in JSON data is
  a `JsonLink<T>`, `{ $link: Link<T> }`.
- An object is the JSON object `{"data": <data>, "schema": <link>}`, with no
  other member, and a schema is a JSON object naming its dialect in
  `$schema`, written as JSON is.
- Blobs carry no type tag or version. A reader knows which kind it expects,
  and the kinds cannot pass for one another: an object has exactly its two
  fields, and a schema has `$schema`. A signature is an object, and like any
  object it cannot pass for one of another schema.
- `json.encode` and `json.decode` are this encoding on its own, for formats
  built on it that are not objects.

## Objects

An object holds its data and the link of its schema, and nothing else, and
its data has to fit the schema. Reading one takes the schema the reader
expects and refuses an object written to any other, so an application does
not mistake another schema's object for one of its own. The same value under
two schemas is two objects.

```ts
import { decodeObject, encodeObject, encodeSchema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";

const login = await encodeSchema(
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
decodeObject(object.bytes, login).link === object.link;
```

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
reading a schema returns a promise and reading an object does not. Every
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

## Semantics

`decodeObject` leaves the data as its encoding reads it, JSON here. An
object is data: anyone can write one to any schema, and nothing about it
belongs to the program that reads it. A program has types of its own, and a
`Semantics` is where objects from outside become values of them, and values
of them become objects. It holds one `Reading` for each schema it takes, and
reads an object by the reading of the schema the object is written to; an
object of any other schema is refused. A reading holds its schema compiled,
and the semantics checks the data against it before the reading turns it
into the program's value, so the reading is left what the schema does not
say. A semantics that writes also holds a `Writing`: the schema it writes
to, which is one of those it reads, and how a value becomes data of that
schema. It reads objects of every schema it has a reading of, and writes to
one, the schema the program writes now. The schemas it reads all have one
encoding, the same `Encoding` object, whose data type ties the readings and
the writing together while the semantics is made; the semantics itself is a
`Semantics<T, V>`, whatever the encoding.

```ts
import { Semantics, type JsonLink, type Link } from "@estoc/object";

interface Note {
  readonly text: string;
  readonly language: string | undefined;
  readonly link: Link<Note>;
}

// A note was first written as {"text"}, and is now written as {"body", "language"}.
const notes: Semantics<Note, { readonly text: string; readonly language: string }> = new Semantics(
  [
    { schema: noteSchema, read: (data, { link }) => ({ text: (data as { text: string }).text, language: undefined, link }) },
    {
      schema: noteWithLanguage,
      read: (data, { link }) => {
        const { body, language } = data as { body: string; language: string };
        return { text: body, language, link };
      },
    },
  ],
  { schema: noteWithLanguage.link, write: ({ text, language }) => ({ body: text, language }) },
);
const note = notes.decode(bytes);
const written = notes.encode({ text: "hello", language: "en" });
```

`encode` writes a value by the writing and reads the object back as
`decode` would, so a value that would not read is refused, and what a
semantics writes, it reads. A semantics without a writing writes nothing.

A semantics with a single reading still draws the line: the shape of the
data is known in the semantics and nowhere else, and the rest of the
program sees only its own type. A newer schema of the program's own, an
older one, and another application's are alike to a semantics, each one
more reading. Which schemas stand for a note is the reader's to say, in its
semantics, and not anything an object or a schema says of itself.

A reading turns an object into a value and does not write it again, so a
value can keep the link of the object it was read from, and the signatures
over that object still apply to it. Read as a value and written again to
another schema, the same content would be another object, which no one has
signed.

A reading can follow the links in its data to the objects they name. It
gets the blobs that were given to `decode`, anything with `get(link)` such
as a `Map`, a bundle or a store, and reads a linked object with `follow` on
the semantics of that object, which refuses a blob whose bytes have another
link. A reading that follows a link fails without its blob.

```ts
interface Reply {
  readonly to: Note;
  readonly text: string;
}

// A reply names the note it answers by link, and reads with that note.
const replies: Semantics<Reply> = new Semantics([
  {
    schema: replySchema,
    read: (data, _, blobs) => {
      const { to, text } = data as { to: JsonLink<Note>; text: string };
      return { to: notes.follow(to.$link, blobs), text };
    },
  },
]);
const reply = replies.decode(bytes, blobs);
```

A reader that takes objects of several schemas but picks something other
than a reading by them, such as a transport for each kind of mailbox, reads
the link of the schema an object names with `schemaOf`, given the encoding
the object is in.

## Identities

An identity of `@estoc/identity` is written as an object of
`identitySchema`, and other objects name it by the link of that object. The
schema holds the shape of an identity, a key in lowercase hex and the name
of its scheme, and no more: which schemes there are, and how long a key is
in each, is for whoever reads identities. An identity in a scheme added
later is written to the same schema, so identities already written keep
their links.

`identities` is the semantics this package reads and writes them with, and comes
with the signatures below. It takes the schemes that `@estoc/identity`
knows, with the key at its scheme's length, so that each identity has one
object and one link, and it refuses an identity in any other scheme, though
its object fits the schema. `identities.encode` writes an identity as its
object, and refuses one it would not read, such as one whose key is not its
scheme's length.

## Signatures

A signature says one thing: this identity stands behind this object. It
carries no role and no time. Who has to sign, and what makes a login or a
contract hold, is for the application that reads the object, by the schema
it pins; anyone can sign an object, whether the object names them or not.
Each signature is a blob of its own, collected and passed on apart from the
others over the same object.

A signature is itself an object, written to `signatureSchema`, so a format
that holds an object can hold a signature. It names its identity and the
object it is over by their links, and the signature is in lowercase hex.
`loadSignatures` compiles the identity and signature schemas with the
validator the application picks, as any schema is, and gives the semantics
this package reads and writes signatures with, which holds `identities` and
`sign`. Reading a signature checks its data against the signature schema,
reads its identity through `identities`, which checks the identity's object
against the identity schema, and verifies the signature. So reading a
signature takes the blob of its identity's object, but not that of the
object signed, since the digest it signs is in the link. Reading a signature
with `decodeObject` and the signature schema, as a viewer of arbitrary
objects would, reads its fields without verifying it. `sign` signs the link
of an object, so it takes anything that has one, such as a value read
through a semantics. The signature it gives has the signer's identity object
as `identity`, whose bytes go along with the signature. It writes the
identity and the signature through their semantics before and after the
signer signs, so a signer is not asked for a signature that would not read,
and a signer whose signature does not verify is refused.

A server that handed out a nonce can build the login object itself and take
back only the signature, with the identity's object:

```ts
import { SoftwareSigner } from "@estoc/identity";
import { linkOf, loadSignatures } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";

const signatures = await loadSignatures(defaultValidator);
const signature = await signatures.sign(object, SoftwareSigner.fromSecretKey("ed25519", secretKey));
// The client sends signature.bytes and signature.identity.bytes.

const expected = encodeObject(login, { audience: "https://app.estoc.dev", nonce: "6f1c0a9e" });
const read = signatures.decode(signatureBytes, new Map([[linkOf(identityBytes), identityBytes]]));
const user = read.object === expected.link ? read.identity : undefined;
```

One identity can sign one object more than once, as a wallet need not sign
deterministically, and each of those signatures reads. Finding the
signatures over an object takes an index by the link they name, so hand an
object over together with its signatures.
