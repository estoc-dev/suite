# @estoc/schema

A schema language over JSON for the objects of `@estoc/object`. A schema
is a title and a list of fields, each of one of six types, and that is
all it can say. So what fits a schema is settled by the language, and two
validators have nothing to differ on.

```
Root       {"$schema": null, "language": "Estoc Schema"}
Schema     {"$schema": <the link of the root>, "title": <a string>, "fields": {<name>: <field>, …}}
Field      {"type": <a type>}, with "items" in an array, and "optional": true where it may be left out
```

The schema of an identity:

```json
{
  "$schema": { "$link": "sha256:854038464fe14f61bc8c9de12ecf81566d48c55b18223f38ba49e5d3c4d04d9d" },
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

A schema is an object written to the root of the language, `schemaRoot`,
and links to nothing else.

- Its data is `title` and `fields`, both of them and nothing more.
- `title` is a string. It sets apart two schemas of the same fields, which
  would otherwise be one blob with one link, and nothing is checked by it.
- `fields` holds each field by its name. A field is not named `$schema`,
  which an object keeps for the link of its schema, and the encoding
  refuses one named `$link`.
- A field holds its `type`, one of the six below. An `array` also holds
  `items`, the type of what it holds: a `type`, with `items` of its own
  when that is an array too. A field of any other type holds no `items`.
- A field that an object may leave out holds `"optional": true`. Any
  other field holds no `optional`, and `false` is refused. The items of
  an array are not optional.
- Any other member, at any depth, is refused.

A schema has one spelling. JCS orders its members, and the language
leaves nothing to write two ways, so the same title and fields are the
same bytes and the same link.

## Types

| `type`    | takes                                                       |
| --------- | ----------------------------------------------------------- |
| `array`   | a JSON array, each item of which fits `items`               |
| `link`    | a link as JSON writes it, `{"$link": "sha256:<hex>"}`       |
| `bytes`   | a string of the characters `0-9a-f`, an even number of them |
| `integer` | an integer no further from zero than 2^53 − 1               |
| `string`  | any string                                                  |
| `boolean` | `true` or `false`                                           |

- `null` fits no type. A field with nothing to hold is optional, and left
  out.
- An integer within that range is read whole by every reader of JSON,
  whatever it reads numbers as.
- Bytes are written in lowercase so that the same bytes are the same
  string.

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
import { encodeObject } from "@estoc/object";
import { array, boolean, type DataOf, integer, link, optional, schema } from "@estoc/schema";

const identitySchema = await schema("Identity", {
  root: link<KeyObject>(),
  agents: array(link<KeyObject>()),
  at: integer(),
  prior: optional(link<SignedIdentityObject>()),
  crisis: optional(boolean()),
});
type IdentityData = DataOf<typeof identitySchema>;

const identity = encodeObject(identitySchema, { root: { $link: rootKey.link }, agents: [], at: Date.now() });
```

- `array`, `link`, `bytes`, `integer`, `string` and `boolean` give the six
  types, and `optional` marks a field.
- `link<T>()` reads as a `JsonLink<T>`. `T` is what the program reads the
  linked blob as, a label the schema does not hold: it says a field is a
  link, and not what the link names.
- `bytes` reads as a `string`, `integer` as a `number`, and an optional
  field as a member that may be absent.
- `schema` returns a promise, as `encodeSchema` does.

A schema someone else wrote is read from its bytes with
`decodeSchema(bytes, schemaValidator)`. `schemaLanguage` is the language
as `@estoc/object` takes one, and a `SchemaDocument` the data of a schema.
