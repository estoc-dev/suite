# @estoc/bundle

A bundle carries blobs together, with one object as the way in. It is a
folder: `index.json` is that object, the root, and every other blob is
filed under the hex of its SHA-256.

```
index.json           the root: the JCS bytes of an object of @estoc/object
blobs/sha256/<hex>   another blob, <hex> the lowercase hex SHA-256 of its bytes
```

A folder is a map from paths to bytes, and that is what `readBundle` takes,
whether the folder was read from a disk, picked in a browser, or unpacked
from a zip. `writeBundle` gives the map back.

```ts
import { readBundle, writeBundle } from "@estoc/bundle";

const files = writeBundle(signature, [message.bytes, signature.identity.bytes]);
const bundle = readBundle(files);
bundle.link;              // signature.link
bundle.get(message.link); // message.bytes
[...bundle.blobs()];      // signature.bytes, message.bytes, signature.identity.bytes
```

## The root

A bundle has a root, and the root is an object, so a reader knows what a
bundle is by the root's schema. Loose files packed together would leave it
guessing. `index.json` has to be the canonical JSON of an object, with
exactly the fields `data` and `schema`. An `index.json` formatted by hand,
or one that holds a schema, makes the whole bundle refused. A signature is
an object too, so it can be the root, with what it is over carried in the
bundle. `writeBundle` takes the root in whatever type a semantics read it
into, such as an `Authorization`, and writes its bytes, so the root is
written as it was signed.

`index.json` is the object itself, not a pointer to it. So nothing in a
bundle is both unsigned and unaddressed: what the bundle has to say is
written into the root, and the root has a link, so it can be referred to
and signed. There is no version file and no metadata beside it.

A bundle with only `index.json` is just an object, such as the mailbox of a
one-time invitation.

## Blobs

A blob's file name is its link, `sha256:<hex>`, with the colon turned into
a slash, as an OCI image layout names its blobs. A path means nothing else,
so the case, Unicode normalization, symlinks and `..` that paths bring with
them do not come up, and another hash algorithm would only be another
directory. A blob can be any bytes: an object, a signature, a schema, or an
image.

A blob whose bytes do not have the link its name says makes the whole
bundle refused: it most likely broke on the way, and saying so at once
beats finding a blob missing when it is read. Other paths are not blobs and
are not read: directory entries, `.DS_Store`, `__MACOSX/`, names in
uppercase hex or of another length, and `blobs/sha512/`. The root need not
be under `blobs/` as well, and does no harm there.

## Reading

A bundle is only a container. Reading one checks the root as above and that
each blob matches its name, and nothing more: it does not parse the other
blobs, look at a clock, or check a schema. A signature under `blobs/` is
bytes, as an image is, so one that does not verify, or whose scheme the
reader does not know, is read all the same.

Signatures are verified where they are used: the signatures of
`@estoc/object` and `readStanding` in `@estoc/authorization` verify what
they read. Verifying once on the way in and trusting it afterwards is what
a store does with what it keeps. If reading a bundle verified signatures, it
would have to know every identity scheme: a reader that predates a scheme
could not read even the root of a card carrying a signature in it, and one
bad signature that nothing refers to would refuse the whole bundle.

A reader starts at the root, reads it through a semantics of the schemas it
expects, and follows its links with `get`. To carry signed content, the root is the
signature over it, or refers to signatures: a chat message travels with the
signature over it as the root, and a card lists the signatures over what it
holds. The reader goes through each signature to the object it is over.

```ts
const signed = signatures.decode(bundle.root, bundle);
const message = decodeObject(bundle.get(signed.object)!, chatSchema);
// signed.identity stands behind message
```

A `Bundle` has the `get` that semantics and `readStanding` take their blobs
by, so a signature is read against the bundle that carries its identity's
object, and a signature made through agents against the bundle that carries
the proxy and its chain as well.

A bundle need not be complete. A blob the root leads to may be left out,
such as a document a contract names by hash that both parties already hold,
and the reader finds out when `get` gives `undefined`. Which blobs to carry
is up to the application that writes the bundle. A blob the root does not
lead to is kept and `get` returns it, but it means nothing: a bundle does
not say which signatures are over an object, nor list the blobs it holds.

## Zip

To move a bundle as one file, `zipBundle` zips its files, and `unzipBundle`
unzips a zip back into the map that `readBundle` takes. Both use zip.js and
return promises.

```ts
const zip = await zipBundle(writeBundle(signature, [message.bytes, signature.identity.bytes]));
const bundle = readBundle(await unzipBundle(zip));
```

`zipBundle` compresses with DEFLATE unless it is given `compress: false`,
and then stores the files as they are. A zip that is encrypted afterwards,
as a message to a mailbox is, is better stored: how far DEFLATE shrinks a
file depends on what it holds, so when someone else writes part of a
bundle, the length of the ciphertext can tell them whether their part
repeats something secret elsewhere in it.

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
them. Other methods can make far more, so `index.json` or a blob compressed
with one, such as Deflate64, is refused rather than unzipped. At the limit
unzipping stops and the whole zip is refused, as it is when an entry does not
unzip to the size or the CRC the zip gives. A zip that holds a path twice is
refused as well, since two tools could each take a different one.

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
