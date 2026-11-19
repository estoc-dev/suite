# @estoc/blog

A post and its body, as objects of `@estoc/object`. A post holds what is
said of it and links to its body, and the body is an object of the schema
of its format.

```
Post           {"title": <a string>, "description"?: <a string>, "date": <a day, as in "2026-10-20">, "body": <the link of its body>}
Markdown Body  {"text": <CommonMark>}
```

## Posts

- A post does not say who wrote it. An identity of `@estoc/identity`
  stands behind a post by signing it, as it signs any object.
- A post does not say which format its body is in. The body names its
  schema, as every object does, and that is its format.
- The closure of a post holds its body, so a store that holds the post
  holds the body with it. A bundle carries the body when the application
  that writes the bundle includes it.
- The schema says that `date` is a string and no more. Whether it is a day
  is checked by the program that uses it as one, such as one that orders
  posts by it.
- An edit to the body is another body and so another post. `@estoc/lineage`
  strings the versions of a post into a series.

## Bodies

A program reads bodies of several schemas as one kind of thing, a `Body`,
which holds the body rendered as HTML. `bodies` is the table of the body
schemas this package reads, an `Implementations` of `@estoc/object`, and
it refuses a body written to any other schema.

```ts
import { bodies, markdownBodyOf, postSchema } from "@estoc/blog";
import { LinkValue, encodeObject, readObject } from "@estoc/object";

const body = markdownBodyOf("Most of our online identities depend on platforms.\n");
const post = encodeObject(postSchema, {
  title: "Imagining the internet from offline",
  date: "2026-10-20",
  body: new LinkValue(body.link),
});

const { data } = await readObject(reader, post.link, postSchema);
(await bodies.read(data.body.link, reader)).html; // "<p>Most of our online identities depend on platforms.</p>\n"
```

- A `Body` is the link of its object with `html`. `markdownBodyOf` gives
  the object, which has the bytes to keep and the link for a post to
  name, and `bodies` reads that link as a `Body`.
- A Markdown body is read as CommonMark. HTML written in its text is
  rendered as text and not as markup, so the body of a post written by
  anyone can be put on a page.
- A format is one more schema with its `Implementation`, which says how
  its data becomes a `Body`. A program that reads other formats lists
  them, with `markdownBody` or without it, in a table of its own.
