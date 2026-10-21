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

const files = writeBundle(envelope, [signature.bytes, message.bytes]);
const bundle = readBundle(files);
bundle.link;              // envelope.link
bundle.get(message.link); // message.bytes
```

## The root

A bundle has a root, and the root is an object, so a reader knows what a
bundle is by the root's schema. Loose files packed together would leave it
guessing. `index.json` has to be the canonical JSON of an object, with
exactly the fields `data` and `schema`. An `index.json` formatted by hand,
or one that holds a signature or a schema, makes the whole bundle refused.

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

Signatures are verified where they are used: `decodeSignature` in
`@estoc/object` and `readStanding` in `@estoc/authorization` verify what
they read. Verifying once on the way in and trusting it afterwards is what
a store does with what it keeps. If reading a bundle verified signatures, it
would have to know every identity scheme: a reader that predates a scheme
could not read even the root of a card carrying a signature in it, and one
bad signature that nothing refers to would refuse the whole bundle.

A reader starts at the root, reads it with the schema it expects, and
follows its links with `get`. To carry signed content, the root refers to
signatures over it: a card lists the signatures over what it holds, and a
chat message travels as an envelope naming the signature over it. The
reader goes through each signature to the object it is over.

```ts
const { signature } = decodeObject(bundle.root, envelopeSchema).data as { signature: Link<Signature> };
const signed = decodeSignature(bundle.get(signature)!);
const message = decodeObject(bundle.get(signed.object)!, chatSchema);
// signed.identity stands behind message
```

A `Bundle` has the `get` that `readStanding` takes its blobs by, so a
signature made through agents is read against the bundle that carries the
proxy and its chain.

A bundle need not be complete. A blob the root leads to may be left out,
such as a document a contract names by hash that both parties already hold,
and the reader finds out when `get` gives `undefined`. Which blobs to carry
is up to the application that writes the bundle. A blob the root does not
lead to is kept and `get` returns it, but it means nothing: a bundle does
not say which signatures are over an object, nor list the blobs it holds.
