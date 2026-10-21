# @estoc/authorization

One identity lets another act for it, offline. It signs an Authorization
naming its agent. When the agent stands behind an object for it, the agent
does not sign that object: it signs a Proxy, which names the object and the
chain of authorizations it acts through. A reader takes one signature and
the blobs it leads to, and reads who stands behind the object by it, and
through which agents.

```
Authorization  {"agent": <identity link>, "until"?: <RFC 3339 date-time>}, signed by the authorizer
Proxy          {"chain": [<signature link>, …], "target": <object link>}, signed by the last agent
```

Both are objects of `@estoc/object`, written to two fixed draft 2020-12
schemas, `authorizationSchema` and `proxySchema`, and signed as any object
is. An Authorization names its agent by the link of the agent's identity
object, as a signature names its signer. The schemas are compiled once, by the validator the application picks:

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
import { Temporal } from "temporal-polyfill";

const grant = await authorizations.authorize(browserKey.identity, wallet, Temporal.Instant.from("2026-10-21T12:00:00Z"));
// The agent receives the signature and the blobs it leads to:
// grant.signature.bytes, grant.object.bytes, and the identity objects of both,
// grant.signature.identity.bytes and grant.object.agent.bytes.
const received = authorizations.readAuthorization(signatureBytes, blobs);
```

Both give a `Signed<Authorization>`: the `Authorization` as read, its `agent`
the agent's identity object and its `until` a `Temporal.Instant` when there
is one, and the `signature` over it, whose identity is the authorizer.
`readAuthorization` takes the signature and looks up the blobs it leads to
in `blobs` by link, as `readStanding` does.

### The end of an authorization

`until` is an RFC 3339 `date-time`. A reader takes it as the instant that
`Temporal.Instant.from` reads, and the authorization holds while the
reader's clock is strictly before that instant. Without `until`, an
authorization does not end.

`authorize` takes the end as a `Temporal.Instant` and writes it in UTC, as
its `toString` does, so one instant gives one object. Another application
can write the same instant other ways, with an offset or with trailing
zeros in its fractional seconds; each way is another object with the same
meaning, and each reads.

Whether `format` is asserted is the validator's business. An `until` that a
validator lets through but that does not read as an instant, such as a date
alone, is refused by `readAuthorization`, and a chain that holds it counts
for nothing. An instant past the year 9999 has no RFC 3339 form, and a
validator that asserts `format` refuses it in `authorize`, before the signer
is asked.

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
first authorizer in `chain`. Each item of `chain` is the link of a
signature over an Authorization, starting with the principal's, and each
authorization after the first is signed by the agent of the one before. The
chain names signatures rather than Authorization objects because anyone can
sign an Authorization object: only a signature says both who authorized and
whom. Only the last agent's own signature over the Proxy counts. The target
is only named, so a reader does not need its bytes.

```ts
const proxy = await authorizations.proxy(login.link, [received], browserKey);
```

It gives a `Signed<Proxy>`: the Proxy as read, its `target` and `chain` as
links, and the agent's signature over it.

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

`readStanding(target, entry, blobs, now)` reads how an identity stands
behind `target` by one signature, `entry`:

- an entry over `target` is its signer's own;
- an entry over a Proxy whose target is `target` is the first authorizer's
  in the chain, when
  - every link in the chain leads to a signature over an Authorization,
  - the agent of each authorization signed the next one,
  - the last agent is the one who signed the Proxy, and
  - every `until` in the chain is after `now`.

The result is the principal and its agents in order, as their identity
objects, with no agents for a direct signature. An entry that stands no one behind `target` throws,
saying why, such as which authorization has ended.

The signatures a chain links to, and the entry itself, are direct signatures,
so a proxy cannot sit in a chain, and a Proxy cannot itself be signed
through another. Authorizing others lengthens the chain within one Proxy,
and the reading does not recurse. A chain has no length limit: whether to
accept agents, and how many, is up to the application, as is who has to
stand behind an object for it to hold.

Two identities are the same when their schemes and their public key bytes
are, as `sameIdentity` in `@estoc/identity` compares them.

### Blobs

Every link from the entry points inward, to the Proxy, its chain, the
authorizations and the identity objects of their signers and agents, so the
reading only looks blobs up by link. `blobs` is anything with `get(link)`: a
`Map`, a bundle, or a store that holds blobs by content. The reading checks
that each blob it gets has the link it asked for, so wrong bytes from a
store make the reading fail, and do not make it read another standing.
Blobs the entry does not lead to are not read.

```ts
import { linkOf } from "@estoc/object";

// The browser key sends its signature over the Proxy as the entry, with the blobs it leads to.
const entry = proxy.signature.bytes;
const identities = [proxy.signature.identity.bytes, received.signature.identity.bytes];
const sent = [proxy.object.bytes, received.signature.bytes, received.object.bytes, ...identities];
// The server files those blobs by link, and reads the entry against the login object it expects.
const blobs = new Map<string, Uint8Array>(sent.map((bytes) => [linkOf(bytes), bytes]));
authorizations.readStanding(login.link, entry, blobs, new Date());
// { identity: <the wallet's identity object>, agents: [<the browser key's>] }
```

To find everyone who stands behind an object, the application reads each entry
it holds. Finding those entries in a store takes an index from objects to
the signatures over them and to the proxies for them; that index belongs
to the store, and an entry it offers wrongly only fails to read.
