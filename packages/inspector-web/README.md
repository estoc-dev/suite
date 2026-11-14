# @estoc/inspector-web

A page that opens an `.eof` file and shows what its blobs read as, from
the root along the links: the link of a blob, the schema it names, and its
fields. The file is a bundle, read by `decodeBundle` of `@estoc/bundle`,
and each blob is read by `inspect` of `@estoc/inspector`.

```sh
pnpm dev      # serve the page
pnpm samples  # write files to open into samples/
```

## What the page shows

The page draws what `inspect` gives and reads nothing else, so it shows
what the blob says of itself:

- The title of a schema is the one the schema gave itself, and stands
  beside the link of the schema.
- Data that fits its schema has the right shape. The page says no more of
  it, and marks nothing as verified.
- The fields are shown whether or not the schema could be read, since the
  object format marks the type of every value.

A row of the field table is a member of the data, or a field of the
schema that the data leaves out. What the validator says of a value is
shown where the value is, down to the item of an array.

The validator names the place of a problem as text, and a field name that
holds `/` or `: ` can spell the place of another value. A problem that
reads as that of more than one value is marked on none of them: it is
listed under the schema, as the validator words it.

## Following links

A file opens at its root. Choosing a link in the data, or the link of a
schema, shows what that link reads as through the same bundle:

- An object is shown as the root is. A schema is an object, so its link
  reads as one: written to the root schema, which is written to itself.
- Bytes that are not an object are shown as their size and their hex.
- A link that the bundle has no blob for is shown as absent, and not as a
  fault of the file: a bundle can leave out a blob that its reader already
  holds.

The link being shown is the fragment of the page's address, so the back
and forward of the browser go from link to link. A fragment that is not a
link shows the root.

## The blobs in the file

Under what is shown, the page lists the blobs of the bundle as the file
orders them, the root first. Each has its link, its size and what it
reads as: the title and the link of the schema it names, or bytes.

A blob is marked `not reached from the root` when following links from
the root, through the blobs the file holds, does not come to it. Where
the file leaves out a blob of the root's closure, what that blob links to
is not known, so a blob marked this way may still be in the closure.

## The file stays in the page

The file comes from elsewhere. What it holds is put in the page as text,
the page sends no request once it is loaded, and it loads no fonts.
