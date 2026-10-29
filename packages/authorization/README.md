# @estoc/authorization

One identity lets another act for it, offline. It signs an Authorization
naming its agent. When the agent stands behind an object for it, the agent
does not sign that object: it signs a Proxy, which names the object and the
chain of authorizations it acts through. A reader takes one signature and
the blobs it leads to, and reads who stands behind the object by it, and
through which agents.

```
Authorization  {"agent": <identity link>}, signed by the authorizer
Proxy          {"chain": [<signature link>, …], "target": <object link>}, signed by the last agent
```

Both are objects of `@estoc/object`, written to two fixed draft 2020-12
schemas, `authorizationSchema` and `proxySchema`, and signed as any object
is. An Authorization names its agent by the link of the agent's identity
object, as a signature names its signer. The schemas are compiled once, by the validator the application picks, together with those of signatures and identities, and `authorizations.signatures` is what it signs and reads signatures with:

```ts
import { loadAuthorizations } from "@estoc/authorization";
import { defaultValidator } from "@estoc/object/default-validator";

const authorizations = await loadAuthorizations(defaultValidator);
const { signatures } = authorizations;
```

## Authorizations

Whoever signs an Authorization is the authorizer, so the object does not
name it, just as a login object does not name who logs in. It lets `agent`
act for the authorizer in full, authorizing others included. The same
`{"agent": …}` signed by two identities is two authorizations. The agent
need not agree to be named; until it signs a proxy, the authorization counts
for nothing.

```ts
const grant = await authorizations.authorize(browserKey.key, wallet);
// The agent receives the link of the signature, and the signature with the blobs it leads to:
// grant.signature.bytes, grant.object.bytes, and the blobs of both identities,
// grant.signature.identity.blobs and grant.object.agent.blobs.
const received = await authorizations.readAuthorization(grant.signature.link, blobs);
```

Both give a `Signed<Authorization>`: the `Authorization` as read, its `agent`
the agent's identity object, and the `signature` over it, whose identity is
the authorizer. `readAuthorization` takes the link of the signature, and
gets the signature and the blobs it leads to from `blobs` by link, as
`readStanding` does.

An authorization has no end, and there is no revocation. Offline, a
revocation may not arrive in time, and if one more blob could undo an
authorization, no reading would be settled. Once signed, an authorization
holds from then on: whoever holds the agent's key acts for the authorizer,
so authorizing a key trusts it as far as the authorizer's own.

## Proxies

A Proxy says that the last agent in `chain` stands behind `target` for the
first authorizer in `chain`. Each item of `chain` is the link of a
signature over an Authorization, starting with the principal's, and each
authorization after the first is signed by the agent of the one before. The
chain names signatures rather than Authorization objects because anyone can
sign an Authorization object: only a signature says both who authorized and
whom. Only the last agent's own signature over the Proxy counts. The target
is only named, so a reader does not need its bytes.

### Actors

An actor stands behind objects for one identity, its principal. Made from a
signer alone, it is the signer's own and signs each object. Made with a
chain, it is the first authorizer's, and signs a Proxy for each object as
the chain's last agent.

```ts
const asWallet = authorizations.createActor(wallet);
const throughKey = authorizations.createActor(browserKey, [received]);
const entry = await throughKey.sign(login.link);
```

`createActor` refuses a chain that does not connect, or that does not end
at the signer, since no reader would count a proxy through it. An actor's
`principal` and `agents` are what a reading gives back of what it signs.

`sign` takes the link of the object alone, and gives an `Entry`: the
signature, and the blobs it leads to, each once. For a proxy those are the
Proxy, the chain's signatures and authorizations, and the blobs of the
identities they name; for a direct signature, the blobs of the signer's
identity. The
signature and its blobs are what a reader takes, and nothing else.

### Why an agent signs a proxy and not the object

A signature over an object means one thing: this identity stands behind it.
If an agent's direct signature counted for whoever authorized it, a reader
would have to search every authorization it holds, and an agent could not
sign anything in its own name. Say a buyer authorizes a broker, and the
broker signs a contract between the buyer and a seller as a witness: a
reader searching for chains would count the witness's signature as the
buyer's. With a proxy, the agent says whom it signs for and through which
chain, and the reader checks each step without guessing.

## Reading

`readEntry(entry, blobs)` reads which object an identity stands behind
by one signature, the one that `entry` links to, and how:

- an entry over a Proxy stands the first authorizer in the chain behind the
  Proxy's target, when
  - every link in the chain leads to a signature over an Authorization,
  - the agent of each authorization signed the next one, and
  - the last agent is the one who signed the Proxy;
- an entry over any other object stands its signer behind it.

The result is the `target`, the link of that object, with the `principal`
and its `agents` in order, as their identity objects, with no agents for a
direct signature. An entry that stands no one behind anything throws, saying
why, such as which blob is missing. The object is only named, so the
blobs need not hold it. A Proxy is read as one only when the blobs hold it;
without it, the entry is its signer's own, behind the Proxy's link.

A reader that expects one object, such as a server that built the login it
asked to have signed, reads with `readStanding(target, entry, blobs)`,
which gives the standing and refuses an entry for any other object. A
reader that learns what the object is from the entry, as a service learns
what a request asks, reads it by `target`, with the schema it expects:

```ts
const { target, principal } = await authorizations.readEntry(bundle.link, bundle);
const request = await readObject(bundle, target, requestSchema);
```

The signatures a chain links to, and the entry itself, are direct signatures,
so a proxy cannot sit in a chain, and a Proxy cannot itself be signed
through another. Authorizing others lengthens the chain within one Proxy,
and the reading does not recurse. A chain has no length limit: whether to
accept agents, and how many, is up to the application, as is who has to
stand behind an object for it to hold.

Two identities are the same when their links are.

### Blobs

Every link from the entry points inward, to the Proxy, its chain, the
authorizations, the identities of their signers and agents, and the roots
of those identities, so the
reading only gets blobs by link, each when it comes to it. `blobs` is a
`Reader` of `@estoc/object`, anything with `get(link)` that answers at once
or with a promise: a `Map`, a bundle, or a store that holds blobs by
content. A reader gives under a link only the blob that the link names, so
the reading looks at the object an entry signs to tell a Proxy from any
other object. A bundle checks its blobs when it is made, and a store hashes
what it gets back, so wrong bytes from a damaged store make the reading
fail, and do not make it read another standing. Blobs the entry does not
lead to are not read.

```ts
import { linkOf } from "@estoc/object";

// The browser key sends the link of its signature as the entry, with the
// signature and the blobs it leads to.
const { signature, blobs: led } = await throughKey.sign(login.link);
const sent = [signature.bytes, ...led];
// The server files those blobs by link, and reads the entry against the login object it expects.
const blobs = new Map<string, Uint8Array>(sent.map((bytes) => [linkOf(bytes), bytes]));
await authorizations.readStanding(login.link, signature.link, blobs);
// { principal: <the wallet's identity object>, agents: [<the browser key's>] }
```

To find everyone who stands behind an object, the application reads each entry
it holds. Finding those entries in a store takes an index from objects to
the signatures over them and to the proxies for them. The application
keeps that index over its store, and an entry the index offers wrongly
only fails to read.
