# @estoc/authorization

One identity lets another act for it, offline. It signs an Authorization
naming its agent. When the agent stands behind an object for it, the agent
does not sign that object: it signs a Proxy, which names the object and the
chain of authorizations it acts through. A reader then finds everyone who
stands behind an object, by their own signature or through agents.

```
Authorization  {"agent": <identity>, "until"?: <RFC 3339 date-time>}, signed by the authorizer
Proxy          {"chain": [<signature link>, …], "target": <object link>}, signed by the last agent
```

Both are objects of `@estoc/object`, written to two fixed draft 2020-12
schemas, `authorizationSchema` and `proxySchema`, and signed as any object
is. The schemas are compiled once, by the validator the application picks:

```ts
import { loadAuthorizations } from "@estoc/authorization";
import { defaultValidator } from "@estoc/object/default-validator";

const authorizations = await loadAuthorizations(defaultValidator);
```

## Authorizations

Whoever signs an Authorization is the authorizer, so the object does not
name it, just as a login object does not name who logs in. It lets `agent`
act for the authorizer in full, authorizing others included. The same
`{"agent": …}` signed by two identities is two authorizations. The agent
need not agree to be named; until it signs a proxy, the authorization counts
for nothing.

```ts
const grant = await authorizations.authorize(browserKey.identity, wallet, "2026-10-21T12:00:00Z");
// The agent receives grant.signature.bytes and grant.object.bytes, and reads them back:
const received = authorizations.readAuthorization(signatureBytes, objectBytes);
```

### The end of an authorization

`until` is an RFC 3339 `date-time`. A reader takes it as the instant that
`Temporal.Instant.from` reads, and the authorization holds while the
reader's clock is strictly before that instant. One instant can be written
several ways, with an offset or with fractional seconds; each way is
another object with the same meaning. Without `until`, an authorization
does not end.

Whether `format` is asserted is the validator's business. An `until` that a
validator lets through but that does not read as an instant, such as a date
alone, is refused by `authorize` and `readAuthorization`, and a chain that
holds it counts for nothing.

There is no revocation. Offline, a revocation may not arrive in time, and if
one more blob could undo an authorization, no reading would be settled. To
be able to take an authorization back, give it a short `until` and renew it.

A signature does not show when it was made, so once `until` has passed,
nothing signed under the authorization counts for its authorizer any more,
including what was signed in time. A login, judged on the spot, is not
affected. Something meant to last, such as a contract, is signed again by
the principal directly, or the application records when it checked it; that
record is the application's state, not part of the format.

## Proxies

A Proxy says that the last agent in `chain` stands behind `target` for the
first authorizer in `chain`. Each entry of `chain` is the link of a
signature over an Authorization, starting with the principal's, and each
authorization after the first is signed by the agent of the one before. The
chain names signatures rather than Authorization objects because anyone can
sign an Authorization object: only a signature says both who authorized and
whom. Only the last agent's own signature over the Proxy counts. The target
is only named, so a reader does not need its bytes.

```ts
const proxy = await authorizations.proxy(login.link, [received], browserKey);
```

`proxy` refuses a chain that does not connect, or that does not end at the
signer, since no reader would count that proxy. It does not look at a
clock.

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

`standingBehind(target, evidence, now)` lists every way an identity stands
behind `target`. An identity P stands behind an object T when there is

- P's signature over T, or
- a Proxy whose target is T, where
  - every entry of the chain reads as a signature over an Authorization,
  - the first entry is signed by P,
  - the agent of each entry signed the next one,
  - the last agent signed the Proxy, and
  - every `until` in the chain is after `now`.

Each way comes back as the principal and its agents in order, with no
agents for a direct signature, and is listed once. The entries of a chain
and the signature over a Proxy have to be direct signatures, so a proxy
cannot sit in a chain, and a Proxy cannot itself be signed through another.
Authorizing others lengthens the chain within one Proxy, and the reading
does not recurse. A chain has no length limit: whether to accept agents,
and how many, is up to the application, as is who has to stand behind an
object for it to hold.

A missing blob, or one that does not read, leaves out the way that needed it
and no other; the reading itself does not fail. With no revocation, more
evidence at the same `now` only adds ways.

Two identities are the same when their schemes and their public key bytes
are, as `sameIdentity` in `@estoc/identity` compares them.

### Evidence

Finding the signatures and proxies over an object takes an index, which
belongs to a store and not to the format. A reading takes any `Evidence`
and checks what it offers, so an index that offers too much changes
nothing. `evidenceFrom` builds one in memory from a set of blobs: every blob
by its link, signatures by the object they are over, and proxies by their
target. A blob that is neither is kept by its link alone.

```ts
const evidence = authorizations.evidenceFrom(blobs);
authorizations.standingBehind(login.link, evidence, new Date());
// [{ identity: wallet.identity, agents: [browserKey.identity] }]
```
