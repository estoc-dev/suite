# @estoc/inspector-web

A page that opens an `.eof` file and shows its root: the link, the schema
the root names, and its fields. The file is a bundle, read by
`decodeBundle` of `@estoc/bundle`, and the root is read by `inspect` of
`@estoc/inspector`.

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

## The file stays in the page

The file comes from elsewhere. What it holds is put in the page as text,
the page sends no request once it is loaded, and it loads no fonts.
