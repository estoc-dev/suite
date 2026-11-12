# @estoc/bundle

A bundle carries blobs together, with one object as the way in. It is one
file: the bytes of that object, the root, then each other blob as a CBOR
byte string.

```
da 65 73 74 3f 82 ...   the root: an object of est, as @estoc/object writes it
58 37 <55 bytes>        a blob: a byte string, its head giving its length
48 <8 bytes>            another
```

`encodeBundle` writes the file and `decodeBundle` reads it into a `Bundle`.

```ts
import { decodeBundle, encodeBundle } from "@estoc/bundle";

const file = encodeBundle(signature, [message.bytes, ...signature.signedIdentity.blobs]);
const bundle = decodeBundle(file);
bundle.link;              // signature.link
bundle.get(message.link); // message.bytes
[...bundle.blobs()];      // signature.bytes, message.bytes, ...signature.signedIdentity.blobs
```

A bundle whose root is an object of JSON is not one file but a
[folder](#folder), read into the same `Bundle`.

## The root

A bundle has a root, and the root is an object, so a reader knows what a
bundle is by the root's schema. Loose files put together would leave it
guessing. The file has to start with an object of est, and bytes that are
anything else make the whole bundle refused. A signature is an object, so
it can be the root, with what it is over carried in the bundle. So can a
schema, which is an object written to its root schema.
`encodeBundle` takes the root as whatever type the program holds it as,
such as a signed identity of `@estoc/identity`, and writes its bytes, so
the root is written as it was signed. It refuses a root that is not an
object of est, since no reader would take the bundle.

The file starts with the object itself, not a pointer to it. So nothing in
a bundle is both unsigned and unaddressed: what the bundle has to say is
written into the root, and the root has a link, so it can be referred to
and signed. There is no version and no metadata beside it.

A file that carries no blob is the bytes of its root. So an object of est
is a bundle as it is, such as the mailbox of a one-time invitation, and
the hash of the file is its link.

## Blobs

- A blob has no name. Its link is the hash of what the byte string holds,
  so no blob can be filed under a link that is not its own.
- A blob is any bytes and is not read: an object, a signature, a schema,
  or an image. An object carried in the file is a byte string as an image
  is, and only the root is written bare.
- The blobs are in any order. `encodeBundle` writes them in the order
  given, each once, and leaves out the root when it is given among them.
- Nothing is compressed, so the blobs come to less than the length of the
  file, and reading has no other limit. The length of the file depends on
  the sizes of the blobs alone, so when a bundle is encrypted on the way,
  the length of the ciphertext does not tell whoever wrote part of it
  whether their part repeats something elsewhere in it.

The whole file is refused when:

- it does not start with an object of est. An object of JSON is not one.
- what follows the root is anything but byte strings, each of a definite
  length under the shortest head, or the last one runs past the end of the
  file.
- it holds a blob twice, the root included.

## Reading

A bundle is only a container. Reading one checks the root and the blobs as
above, and nothing more: it does not parse the other blobs, look at a
clock, or validate against a schema. A signature carried as a blob is
bytes, as an image is, so one that does not verify, or whose scheme the
reader does not support, is read all the same.

Signatures are verified where they are used: `signatures.read` in
`@estoc/identity` verifies what it reads. If reading a bundle verified
signatures, it would have to support every identity scheme: a reader that
predates a scheme could not read even the root of a card carrying a
signature in it, and one bad signature that nothing refers to would refuse
the whole bundle.

A reader starts at the root, reads it with the schema it expects, or picks
among several by `schemaOf`, and follows its links with `get`. To carry
signed content, the root is the signature over it, or refers to signatures:
a chat message travels with the signature over it as the root, and a card
lists the signatures over what it holds. The reader goes through each
signature to the object it is over.

```ts
const signature = await signatures.read(bundle.link, bundle, noIdentityVersions);
const message = await readObject(bundle, signature.object, chatSchema);
// signature.signedIdentity.identity stands behind message
```

A `Bundle` is a `Reader`, with the `get` that `readObject` and verifiers
such as `signatures.read` take their blobs by, so a signature is read
against the bundle that carries its signed identity's blobs. The identity
versions are the reader's own: one that keeps the identity versions it has
seen passes its `SeenIdentityVersions` in place of `noIdentityVersions`, and
an agent its root removed no longer reads as the root.

A bundle need not be complete. A blob in the root's closure may be left
out, such as a document a contract names by hash that both parties already
hold, and the reader finds out when `get` gives `undefined`. Which blobs to
carry is up to the application that writes the bundle. A blob outside the
root's closure is kept and `get` returns it, but it means nothing: a bundle
does not say which signatures are over an object.

## Folder

A bundle whose root is an object of JSON is a folder: `index.json` is the
root, and every other blob is filed under the hex of its SHA-256. The
objects of the other packages are of est, so none of them writes a folder
or reads one.

```
index.json           the root: the JCS bytes of an object of JSON
blobs/sha256/<hex>   another blob, <hex> the lowercase hex SHA-256 of its bytes
```

A folder is a map from paths to bytes, and that is what `readBundle` takes,
whether the folder was read from a disk, picked in a browser, or unpacked
from a zip. `writeBundle` gives the map back.

```ts
import { readBundle, writeBundle } from "@estoc/bundle";

const files = writeBundle(root, [hello.bytes, image]);
const bundle = readBundle(files);
```

- `index.json` has to be the canonical JSON of an object, naming its schema
  in `$schema`. An `index.json` formatted by hand, or one that is not an
  object, such as JSON that names no schema, makes the whole bundle
  refused, and `writeBundle` refuses such a root. An object of est is not
  one.
- A blob's file name is its link, `sha256:<hex>`, with the colon turned
  into a slash, as an OCI image layout names its blobs. A path means
  nothing else, so the case, Unicode normalization, symlinks and `..` that
  paths bring with them do not come up.
- A blob whose bytes do not have the link its name says makes the whole
  bundle refused: it most likely broke on the way, and saying so at once
  beats finding a blob missing when it is read.
- Other paths are not blobs and are not read: directory entries,
  `.DS_Store`, `__MACOSX/`, names in uppercase hex or of another length,
  and `blobs/sha512/`. The root need not be under `blobs/` as well, and
  does no harm there.

## Zip

To move a folder as one file, `zipBundle` zips its files, and `unzipBundle`
unzips a zip back into the map that `readBundle` takes. Both use zip.js and
return promises.

```ts
const zip = await zipBundle(writeBundle(root, [hello.bytes, image]));
const bundle = readBundle(await unzipBundle(zip));
```

`zipBundle` compresses with DEFLATE unless it is given `compress: false`,
and then stores the files as they are, as a packed bundle is.

The entries start at the bundle's root: `index.json` is at the top of the
zip, not in a folder. A zip with the bundle in a folder unzips to no
`index.json`, and reading it is refused. Entries stored as they are or
compressed with DEFLATE read, in any order. `zipBundle` dates every entry
1980-02-01. A zip records local time, so a real date would tell when the zip
was made and, from that, in which time zone. The date is a month after the
earliest a zip can hold, so that no conversion between time zones takes it
below that. The same files in the same order zip to the same bytes, in a
browser and in Node.

Unzipping holds what comes out in memory and writes nothing. Only
`index.json` and the blobs under `blobs/sha256/` are unzipped, so the map
has paths of only those two shapes, and saving it as a folder stays inside
that folder: an entry such as `../escape`, `.DS_Store` or one under
`__MACOSX/` is not unzipped.

A zip comes from someone else, so unzipping has limits: 64 MiB unzipped and
10,000 entries, unless the caller gives others. An entry is unzipped as it is
read, 4 KiB at a time, and the bytes are counted as they come out, since the
sizes a zip gives for its entries can be false. DEFLATE makes at most about a
thousand times its size, so a few MiB at most come out before the count stops
them. The whole zip is refused when:

- it goes over a limit; unzipping stops there.
- `index.json` or a blob is compressed with a method other than DEFLATE,
  such as Deflate64. Other methods can make far more, so the entry is
  refused rather than unzipped.
- an entry does not unzip to the size or the CRC the zip gives.
- it holds a path twice, since two tools could each take a different one.

zip.js takes the size of the pieces it unzips from a setting shared by all of
zip.js in the program, and reads it for each entry. `unzipBundle` sets it to
4 KiB each time it starts, over whatever was set before, so other uses of
zip.js in the same program work in pieces of that size too. What they zip and
unzip stays the same, at a small cost in speed. While an unzip runs, other
code in the program is expected not to set `chunkSize` or call
`resetConfiguration()`: the entries still to come would be unzipped in pieces
of the new size, and a larger size lets more come out of a piece before it is
counted.

The directory at the end of a zip lists its entries, and it is what most
tools read. `unzipBundle` unzips the entries it lists under the paths of a
bundle, each from where the directory says it starts, and refuses the zip
when the header there is missing or gives another method, size or CRC. Bytes
anywhere else are not entries, even when they look like one: those of a blob
that is itself a zip, or of the zip's comment. A reader that goes from header
to header instead can come to entries the directory does not list, and read
another bundle from the same zip.

## Packed

`packBundle` zips the folder of a root and blobs without compression, and
`unpackBundle` reads it back.

```ts
import { packBundle, unpackBundle } from "@estoc/bundle";

const zip = await packBundle(root, [hello.bytes, image]);
const bundle = await unpackBundle(zip);
```

A packed bundle is a zip like any other, so it can be kept as a file, and
`unzipBundle` reads it. It is not compressed, for two reasons:

- What arrives comes from someone else, and a zip without compression is
  larger than its files. `unpackBundle` refuses a zip whose files come to
  more bytes than the zip itself, which refuses none that `packBundle`
  writes and keeps a compressed one from unzipping to far more than
  arrived. It keeps the other limit of `unzipBundle`, 10,000 entries.
- What travels is encrypted on the way, by TLS or by sealing it to a
  mailbox's key. How far DEFLATE shrinks a file depends on what it holds,
  so when someone else writes part of a bundle, the length of the
  ciphertext could tell them whether their part repeats something secret
  elsewhere in it. Without compression the length depends on the sizes of
  the files alone.
