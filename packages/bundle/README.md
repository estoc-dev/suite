# @estoc/bundle

A bundle carries blobs together, with one object as the way in. It is one
file: the bytes of that object, the root, then each other blob as a CBOR
byte string. The file takes the extension `.eof`, and starts with the tag
of the Estoc Object Format, `eof!` in ASCII.

```
da 65 6f 66 21 82 ...   the root: an object, as @estoc/object writes it
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

## The root

A bundle has a root, and the root is an object, so a reader knows what a
bundle is by the root's schema. Loose files put together would leave it
guessing. The file has to start with an object, and bytes that are
anything else make the whole bundle refused. A signature is an object, so
it can be the root, with what it is over carried in the bundle. So can a
schema, which is an object written to its root schema.
`encodeBundle` takes the root as whatever type the program holds it as,
such as a signed identity of `@estoc/identity`, and writes its bytes, so
the root is written as it was signed. It refuses a root that is not an
object, since no reader would take the bundle.

The file starts with the object itself, not a pointer to it. So nothing in
a bundle is both unsigned and unaddressed: what the bundle has to say is
written into the root, and the root has a link, so it can be referred to
and signed. There is no version and no metadata beside it.

A file that carries no blob is the bytes of its root. So an object is a
bundle as it is, such as the mailbox of a one-time invitation, and
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

- it does not start with an object.
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
