# @estoc/object

A JSON value written to a JSON Schema, encoded so that a value has one byte
string and one link. An identity signs an object's link; what the value
means comes from its schema, and who has to sign is up to the application
that reads it.

```
Schema     a JSON Schema document: a JSON object naming its dialect in $schema
Object     {"data": <any JSON value>, "schema": "sha256:<the Schema's link>"}
Identity   an Object written to the identity schema, with the data
           {"publicKey": <hex>, "scheme": <scheme>}
Signature  an Object written to the signature schema, with the data
           {"identity": "sha256:<the Identity's link>", "object": "sha256:<the Object's link>", "signature": <hex>}
```

The encoding, objects, schemas and validators are the substrate that every
application shares. Views are how a program reads objects as values of its
own types. Identities and signatures are two views, kept in this package
because the packages built on it sign and name identities; another
application can read the same objects without them.

## Encoding

- A blob is the JCS ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785))
  encoding of a JSON value, in UTF-8. Its link is `sha256:` followed by the
  SHA-256 of those bytes in lowercase hex.
- Decoding is strict: the bytes must be exactly the JCS encoding of the value
  they hold. Invalid UTF-8, a byte order mark, whitespace, keys out of order
  or repeated, needless escapes, and numbers not written the shortest way
  (`1.0`, `1e2`, `-0`, `1152921504606846977`) are refused, as JCS itself
  refuses lone surrogates, NaN and Infinity. There are no further rules on
  the JSON.
- Numbers are IEEE 754 doubles, written as JCS writes them: 2^60 as
  `1152921504606847000`, 10^21 as `1e+21`. Integers up to 2^53 − 1 in
  magnitude are exact in every language; write larger integers and decimal
  amounts as strings when they have to be exact.
- Blobs carry no type tag or version. A reader knows which kind it expects,
  and the kinds cannot pass for one another: an object has exactly its two
  fields, and a schema has `$schema`. A signature is an object, and like any
  object it cannot pass for one of another schema.
- In TypeScript a link is a `Link<T>` and the bytes of a blob are a
  `Bytes<T>`, `T` being what the blob is read as, so the compiler refuses the
  bytes of a signature handed to `decodeObject` rather than to
  `signatures.decode`, which verifies them. A link to a blob of no known
  kind, such as the object a signature is over, is a `Link<never>`, and
  reads as any. The type is a label, not a check: bytes read from a file or
  the network pass as any `Bytes<T>`, and decoding them is what checks them.
- Encoding goes through the same checks as decoding, so what is encoded here
  decodes again with the same validator.
- `encodeJson` and `decodeJson` are this encoding on its own, for formats
  built on it that are not objects.

## Objects

An object holds exactly `data` and `schema`, and its data has to fit the
schema. Reading one takes the schema the reader expects and refuses an object
written to any other, so an application does not mistake another schema's
object for one of its own. The same value under two schemas is two objects.

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

A schema holds all that its data is checked against. A `$ref` reaches the
schema's own parts and nothing elsewhere, so the link of a schema fixes what
its objects may hold, and no one changes that later by changing what a URL
names. Where the data holds a link, the schema writes out what a link looks
like: `linkSchema` is `{"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"}`,
to place there.

## Validators

Whether a value fits a schema is the validator's call. A validator compiles a
schema once, when the schema is read, and the schema keeps the result, so
reading a schema returns a promise and reading an object does not. Every
validator works offline and keeps to three rules:

- A `$ref` to anything outside the schema fails compilation, rather than the
  validation that happens to reach it. A `$ref` in a place the dialect
  ignores, such as under `then` without `if`, has no effect.
- The same schema and value give the same answer every time.
- A dialect it does not support fails compilation.

Anything else, such as whether `format` is asserted or which regular
expression dialect `pattern` uses, is the validator's own. A signature
commits to bytes, so a stricter validator can replace another without any
blob changing.

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

## Views

`decodeObject` leaves the data as JSON. An object is data: anyone can write
one to any schema, and nothing about it belongs to the program that reads
it. A program has types of its own, and a `View` is where objects from
outside become values of them. It holds one
`Reading` for each schema it takes, and reads an object by the reading of
the schema the object is written to; an object of any other schema is
refused. `reading` makes one that validates the data against the schema
before it turns it into the program's value.

```ts
import { reading, View, type Link } from "@estoc/object";

interface Note {
  readonly text: string;
  readonly link: Link<Note>;
}

// A note was first written as {"text"}, and later as {"body", "language"}.
const notes = new View<Note>([
  reading(noteSchema, (data, { link }) => ({ text: (data as { text: string }).text, link })),
  reading(noteWithLanguage, (data, { link }) => ({ text: (data as { body: string }).body, link })),
]);
const note = notes.decode(bytes);
```

A view with a single reading still draws the line: the shape of the data is
known in the reading and nowhere else, and the rest of the program sees only
its own type. A newer schema of the program's own, an older one, and
another application's are alike to a view, each one more reading. Which
schemas stand for a note is the reader's to say, in its view, and not
anything an object or a schema says of itself.

A reading turns an object into a value and does not write it again, so a
value can keep the link of the object it was read from, and the signatures
over that object still apply to it. Read as a value and written again to
another schema, the same content would be another object, which no one has
signed. `encode` writes data to one of the view's schemas and reads it back
as `decode` would; turning a value back into data is left to each type.

A reading can follow the links in its data to the objects they name. It
gets the blobs that were given to `decode`, anything with `get(link)` such
as a `Map`, a bundle or a store, and reads a linked object with `follow` on
the view of that object, which refuses a blob whose bytes have another
link. A reading that follows a link fails without its blob.

```ts
interface Reply {
  readonly to: Note;
  readonly text: string;
}

// A reply names the note it answers by link, and reads with that note.
const replies = new View<Reply>([
  reading(replySchema, (data, _, blobs) => {
    const { to, text } = data as { to: Link<Note>; text: string };
    return { to: notes.follow(to, blobs), text };
  }),
]);
const reply = replies.decode(bytes, blobs);
```

A reader that takes objects of several schemas but picks something other
than a reading by them, such as a transport for each kind of mailbox, reads
the link of the schema an object names with `schemaOf`.

## Identities

An identity of `@estoc/identity` is written as an object of
`identitySchema`, and other objects name it by the link of that object. The
schema holds the shape of an identity, a key in lowercase hex and the name
of its scheme, and no more: which schemes there are, and how long a key is
in each, is for whoever reads identities. An identity in a scheme added
later is written to the same schema, so identities already written keep
their links.

`identities` is the view this package reads them with. It takes the schemes
that `@estoc/identity` knows, with the key at its scheme's length, so that
each identity has one object and one link, and it refuses an identity in
any other scheme, though its object fits the schema. `encodeIdentity`
writes an identity as its object.

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
`signatures` is the view this package reads them with, with one reading. It
needs no validator: it checks the fields itself, reads the identity from
its object through `identities`, and verifies the signature. So reading a
signature takes the blob of its identity's object, but not that of the
object signed, since the digest it signs is in the link. Reading a
signature with `decodeObject` and the signature schema, as a viewer of
arbitrary objects would, reads its fields without verifying it. `sign`
signs the link of an object, so it takes anything that has one, such as a
value read through a view. The signature it gives has the signer's identity
object as `identity`, whose bytes go along with the signature.

A server that handed out a nonce can build the login object itself and take
back only the signature, with the identity's object:

```ts
import { SoftwareSigner } from "@estoc/identity";
import { linkOf, sign, signatures } from "@estoc/object";

const signature = await sign(object, SoftwareSigner.fromSecretKey("ed25519", secretKey));
// The client sends signature.bytes and signature.identity.bytes.

const expected = encodeObject(login, { audience: "https://app.estoc.dev", nonce: "6f1c0a9e" });
const read = signatures.decode(signatureBytes, new Map([[linkOf(identityBytes), identityBytes]]));
const user = read.object === expected.link ? read.identity : undefined;
```

One identity can sign one object more than once, as a wallet need not sign
deterministically, and each of those signatures reads. Finding the
signatures over an object takes an index by the link they name, so hand an
object over together with its signatures.

