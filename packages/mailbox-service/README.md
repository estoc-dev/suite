# @estoc/mailbox-service

A mailbox service keeps messages for receivers who are not online. It is
the receiving side of an HTTP mailbox of `@estoc/mailbox`: a receiver
writes a url at the service into a mailbox, and senders post there as they
post to any HTTP mailbox.

An identity has an account at a service, one for each identity, and opens
it by signing the service's offer. The identity is the account's key: the
service hands out no secret to keep, and whoever signs as the identity
reaches the account from any device.

```
Account offer    {"identity": <link of the service's identity>}, signed by the service
Acknowledgement  {"accepted": <link of the signature over the offer>, "at": <milliseconds>}, signed by the service
```

Both are objects of `@estoc/object`, written to two fixed draft 2020-12
schemas, `accountOfferSchema` and `acknowledgementSchema`, which the client
and the service share. The client is `@estoc/mailbox-service`, and the
service `@estoc/mailbox-service/server`.

## The offer

A service has an identity of its own. It signs one offer, which names that
identity, so each service's offer has a link of its own, and a signature
that accepts one service's offer accepts no other's.

The service answers `GET /offer` with a bundle: its signature over the
offer as the root, with the offer, the service's identity and their
schemas. Anyone can write an offer and sign it, so what makes an offer the
service's is the origin it came from: the client gets it from the
service's origin over TLS, and takes the identity that signed it as the
service's. An offer signed by another identity than the one it names is
refused.

```ts
import { loadServices } from "@estoc/mailbox-service";
import { defaultValidator } from "@estoc/object/default-validator";

const services = await loadServices(store, { validator: defaultValidator });
const offer = await services.offer("https://mail.example");
```

`offer` takes an origin alone, a scheme, a host and a port, and refuses a
url with a path. It takes `https://`, or `http://` to the client's own
machine, `localhost`, `127.0.0.1` or `[::1]`, as in development. It
follows no redirect, since a redirect would take it to another origin than
the one it trusts the offer for.

## Opening an account

Opening an account is accepting the offer: an identity signs it, and the
account is the account of whoever signed. A wallet asks its holder to
confirm each signature, so the wallet can instead authorize a key on the
device with `@estoc/authorization`, and the device signs a Proxy for the
offer. The account is still the wallet's.

`accept` takes an actor of `@estoc/authorization`, and opens the account of
its principal:

```ts
const account = await offer.accept(authorizations.createActor(wallet));
// or, for the wallet, by a key on the device that it authorized:
const account = await offer.accept(authorizations.createActor(deviceKey, [grant]));
```

The actor signs the offer, or a proxy for it, and `accept` posts the
bundle of that signature to `POST /`: the signature as the root, with the
identity, and for a proxy the Proxy and its chain. The offer and the
schemas are left out, since the service has them.

The service reads who stands behind its offer by the root, with
`readStanding` at its clock, opens an account for that identity, and
answers with its signature over an acknowledgement of the root. `at` is
when it received the root. The answer is a bundle: the service's signature
as the root, with the acknowledgement, the acceptance, the offer and all
they lead to.

| Status | Meaning |
|---|---|
| 201 | the account opened; the answer is its acknowledgement |
| 200 | the identity had an account; the answer is that account's acknowledgement |
| 400 | the bundle does not read, or its root does not stand anyone behind this service's offer |
| 413 | the body is over 64 KiB |

An identity has one account at a service. When an acceptance comes again,
or the same identity accepts again by another device or another chain, the
service answers with the acknowledgement it sent when the account opened.
That acknowledgement links to the first acceptance, so a second device
gets the first device's proxy and chain with it. The client reads the
acceptance at the acknowledgement's `at`, when the service received it,
since an authorization in its chain may have ended since, and refuses an
acknowledgement that is signed by another identity than the service's or
that is of another identity's account.

The service signed the offer and the acknowledgement, and the identity
signed the offer, so together they show anyone that this service opened an
account for this identity.

### What the client keeps

`accept` writes the service's signatures over the offer and over the
acknowledgement to the store as mine, with all they lead to. Another
device that syncs the store learns which services the identity has
accounts at without asking them. When the service refuses, or its answer
is refused, nothing is written.

`accept` gives the `Account`: the identity whose account it is, the
service's identity, `at`, and the link of the service's signature over the
acknowledgement.

## The service

```ts
import { loadMailboxService, MemoryAccounts } from "@estoc/mailbox-service/server";

const service = await loadMailboxService(serviceKey, { store, accounts: new MemoryAccounts(), validator: defaultValidator });
export default { fetch: (request: Request) => service.fetch(request) };
```

`loadMailboxService` takes the signer of the service's identity, signs the
offer once, and writes the signature with the offer to `store`, a store of
`@estoc/store`. Each acknowledgement it signs is written there too, as the
service's own, with the acceptance and all it leads to, and what the bundle
of an acceptance holds besides is dropped.

`accounts` holds one row for each identity: the link of the identity, and
the link of the service's signature over the acknowledgement of its
account. Its `add` keeps a row only for an identity without one, in one
step, so two acceptances of one identity that arrive together open one
account. `MemoryAccounts` keeps the rows in memory.

`fetch` takes a `Request` and gives a `Response`, as a fetch handler does.
No request carries credentials, so it answers any origin, and it answers
the CORS preflight that a browser sends before it posts a zip to another
origin. A body is read up to 64 KiB.

Bundles travel both ways as the zip that `zipBundle` writes with
`compress: false`. A zip without compression is larger than its files, so
a reader refuses a zip whose files come to more than its own size, and a
small zip cannot unzip to much more than arrived.

A service opens no account for its own identity: its signature over its
offer is what `GET /offer` answers, and posting that back accepts nothing.
