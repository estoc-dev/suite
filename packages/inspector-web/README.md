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

The link, the schema and the fields of a blob are drawn from what
`inspect` gives, so they show what the blob says of itself:

- The title of a schema is the one the schema gave itself, and stands
  beside the link of the schema.
- Data that fits its schema has the right shape. The fields say no more
  of it: a signature whose data fits its schema is not verified by that.
- The fields are shown whether or not the schema could be read, since the
  object format marks the type of every value.

A row of the field table is a member of the data, or a field of the
schema that the data leaves out. What the validator says of a value is
shown where the value is, down to the item of an array.

The validator names the place of a problem as text, and a field name that
holds `/` or `: ` can spell the place of another value. A problem that
reads as that of more than one value is marked on none of them: it is
listed under the schema, as the validator words it.

What the page itself reads an object as is shown apart from these, under
a title of its own.

## What the page reads an object as

The page has schemas of its own for two things: the body of a post, and a
signature.

- What the page reads an object of one of those schemas as stands above
  its fields. The fields stay, since they are what the blob says of
  itself.
- Where the page could read the object, it shows what it read under a
  title such as `Read by this page as a signature`. The title names this
  page's reading: the schema titles itself, and another program may read
  the same object as something else.
- Where the page could not read the object, it shows what stopped the
  reading, under a title such as `Not read by this page as a signature`.
  Where that is a blob the file leaves out, the page names its link, as a
  link to follow. A bundle can leave out a blob that its reader already
  holds, so this is not shown as a fault of the file.
- The schema is matched by its link and not by its title. The page holds
  the schema, so it reads the object, or says why it could not, whether or
  not the file gives the blob of the schema. Where the file leaves that
  blob out, the field table can mark no problem, and what does not fit is
  said above the fields alone.

### The body of a post

The page reads the body schemas that `bodies` of `@estoc/blog` lists, which
for now is the Markdown body, and shows the body rendered.

- A body whose data does not fit its schema is not read, and what does
  not fit is said there.
- A post is shown by its fields. Its `body` is a link, and following it
  shows the body.

### A signature

The page reads an object of the signature schema of `@estoc/identity` by
`Signatures.implementation`, which verifies it: the signed identity it
names, the identity and its keys are read from the file.

- A signature that verifies is shown as the identifier of who signed, the
  key that signed and the object it signs, each a link to follow. The
  signature names the object by link, so it verifies where the file leaves
  the object out.
- The page verifies each signature by itself, with `noIdentityVersions`:
  the signature is honored by the identity version it carries and those
  that version follows alone. The page looks at no other identity
  versions, those of the same file among them, so a signature made before
  a crisis is shown as read where the file holds the crisis too. The page
  says so under each signature it shows.
- The page takes keys of the `ed25519`, `eip191` and `solanaOffchain`
  schemes. A signature whose identity names a key of another schema is
  not read.
- A signature that does not verify is not read, and neither is one whose
  signed identity, identity or key the file leaves out.

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
and the page loads no fonts. Once the page is loaded, opening a file and
showing what it holds send no request.

A rendered body is the one place where the page puts markup of its own
making:

- HTML written in a Markdown body is rendered as text.
- An image in a body names an address, and the page loads no image: its
  content security policy refuses them, so the text that stands for the
  image is shown in its place.
- A link in a body to an address on the web is an ordinary link. Choosing
  it is the reader's request: the browser follows it as it does any link,
  and leaves the page.
