# @estoc/schema

A schema language over est for the objects of `@estoc/object`. A schema
is a title and a list of fields, each of one of seven types, and that is
all it can say. So what fits a schema is settled by the language, and two
validators have nothing to differ on.

```
Schema     an object whose data is {"title": <a string>, "fields": {<name>: <field>, …}}
Field      {"type": <a type>}, with "items" in an array, and "optional": true where it may be left out
```

The data of the schema of an identity, shown as JSON:

```json
{
  "title": "Identity",
  "fields": {
    "root": { "type": "link" },
    "agents": { "type": "array", "items": { "type": "link" } },
    "at": { "type": "integer" },
    "prior": { "type": "link", "optional": true },
    "crisis": { "type": "boolean", "optional": true }
  }
}
```

## Schemas

A schema is an object of `@estoc/object` in est. Its data is a title and
fields, and it is written to the root schema.

- Its fields are `title` and `fields`, both of them and nothing more.
- `title` is a string. It sets apart two schemas of the same fields, which
  would otherwise be one blob with one link, and nothing is checked by it.
- `fields` holds each field by its name, which is any string: est names
  the schema of an object by its place and not by a field.
- A field holds its `type`, one of the seven below. An `array` also holds
  `items`, the type of what it holds: a `type`, with `items` of its own
  when that is an array too. A field of any other type holds no `items`.
- A field that an object may leave out holds `"optional": true`. Any
  other field holds no `optional`, and `false` is refused. The items of
  an array are not optional.
- Any other member, at any depth, is refused.

A schema has one spelling. est orders the members of a map, and the
language leaves nothing to write two ways, so the same title and fields
are the same bytes and the same link.

## The root schema

The root schema is the schema that every schema is written to, and it is a
schema of the language like any other:

```
OBJECT([ "self",
         { "title": "Schema",
           "fields": { "title": { "type": "string" }, "fields": { "type": "any" } } } ])
```

- It is written to itself, which est marks by the string `"self"` in place
  of the link of a schema, so its own data fits it. It is 69 bytes, and
  `rootSchema` holds it.
- It says that a schema holds a title, a string, and fields, of any value.
  What the fields of a schema may hold is more than a schema of this
  language can say, so the language checks it when it reads a schema, and
  refuses a document that fits the root schema but is not one of its own.
- A schema links to the root schema and to nothing else, so the closure of
  a schema is the two of them: `blobs` of a schema holds both, and they go
  wherever an object of the schema goes.
- A schema written to another root schema is of another language, and is
  refused.

## Types

| `type`    | takes                                           |
| --------- | ----------------------------------------------- |
| `array`   | an array, each item of which fits `items`       |
| `link`    | a link                                          |
| `bytes`   | bytes, of any length                            |
| `integer` | an integer no further from zero than 2^53 − 1   |
| `string`  | any string                                      |
| `boolean` | `true` or `false`                               |
| `any`     | any value of est: one of the six above or a map |

- est has no null and no float, so neither fits a type. A field with
  nothing to hold is optional, and left out.
- A link is a link and bytes are bytes as est writes them: a string fits
  neither, whatever it holds.
- `any` takes a value without saying what it holds, as the fields of a
  schema are to the root schema. The links in it are followed all the
  same, since est finds them without a schema.

## What fits

The data of an object fits its schema when:

- each of its members is a field of the schema,
- every field that is not optional is among them, and
- each member is a value of the type of its field.

A schema asks for nothing else: no least or greatest value, no length, no
count, no fixed value. A rule of that kind belongs to the program that
reads the object, which checks it where it checks what else a schema
cannot say, such as whether a signature verifies.

`schemaValidator` is the validator of the language. It lists everything
that does not fit, each with its place in the data, as in
`#/agents/0: not a link`.

## Writing a schema

`schema` writes one from a title and fields, and what a program reads the
data of its objects as follows from the same fields:

```ts
import { EstLink, encodeObject } from "@estoc/object";
import { array, boolean, type DataOf, integer, link, optional, schema } from "@estoc/schema";

const identitySchema = schema("Identity", {
  root: link<KeyObject>(),
  agents: array(link<KeyObject>()),
  at: integer(),
  prior: optional(link<SignedIdentityObject>()),
  crisis: optional(boolean()),
});
type IdentityData = DataOf<typeof identitySchema>;

const identity = encodeObject(identitySchema, { root: new EstLink(rootKey.link), agents: [], at: Date.now() });
```

- `array`, `link`, `bytes`, `integer`, `string`, `boolean` and `any` give
  the seven types, and `optional` marks a field.
- `link<T>()` reads as an `EstLink<T>`. `T` is what the program reads the
  linked blob as, a label the schema does not hold: it says a field is a
  link, and not what the link names.
- `bytes` reads as a `Uint8Array`, `integer` as a `number`, `any` as an
  `Est`, and an optional field as a member that may be absent.

A schema someone else wrote is read from its bytes with
`decodeSchema(bytes, schemaValidator)`. `schemaLanguage` is the language
as `@estoc/object` takes one, and a `SchemaDocument` what a schema holds.
