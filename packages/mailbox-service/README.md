# @estoc/mailbox-service

A mailbox service keeps messages for receivers who are not online. It is
the receiving side of an HTTP mailbox of `@estoc/mailbox`: a receiver
writes a url at the service into a mailbox, and senders post there as they
post to any HTTP mailbox. This package reaches such a service and opens
accounts there, and no more: its handler answers where the service is and
the acceptance of its offer, and receives no messages.

## Addressing

A service is named by its identity. Its origin is where that identity is
reached for now, and the service says so by signing a Service: at `at` it
is at `origin`, and makes these offers. Every answer of the service is
signed by its identity, so a client goes by who signed an answer, not by
where the bytes came from; TLS keeps them private, and vouches for the
service on first contact alone.

What a client posts to, the service gives it: each offer in a Service comes
with an id, 16 random bytes in hex, and the address is the origin and the
id, `<origin>/<id>`. That is the one rule for making a url. An id names one
thing for good, and the service keeps it: once what it names ends, the
service answers 410 there, and gives the id to nothing else. A request
names the object it acts on by link, so where the service moves, neither a
request nor a signature changes.

```
Service          {"origin": <origin>, "at": <milliseconds>, "offers": [{"offer": <link of the service's signature over the offer>, "accept": <id>}, …]}, signed by the service
Account offer    {"identity": <link of the service's identity>}, signed by the service
Acknowledgement  {"accepted": <link of the signature over the offer>, "at": <milliseconds>}, signed by the service
```

All three are objects of `@estoc/object`, written to fixed draft 2020-12
schemas, `serviceSchema`, `accountOfferSchema` and `acknowledgementSchema`,
which the client and the service share. The client is
`@estoc/mailbox-service`, and the service `@estoc/mailbox-service/server`.

An offer names no origin and no id. It is what an identity signs to accept
it, so it stays one object, with one link, wherever the service is reached.

## Reaching a service

```ts
import { loadServices } from "@estoc/mailbox-service";
import { defaultValidator } from "@estoc/object/default-validator";

const services = await loadServices(store, { validator: defaultValidator });
const service = await services.at("https://mail.example");
```

`at` gets the Service at an origin, from `GET /`: a bundle with the
service's signature over the Service as the root, and the offers it lists,
the service's signatures over them, the service's identity and their
schemas. What the origin answers over TLS is the service's, so `at` takes
the identity that signed the Service as the service's, and refuses a
Service that names another origin than the one asked, or that lists an
offer that another identity signed. It writes the service's signature over
the Service to the store as mine, with all it leads to, and gives a
`Service`: the service's identity, its origin, `at`, the link of the
signature, and `account`, the offer of an account when the Service lists
one. Offers of schemas the client does not read are passed over.

`at` takes an origin alone, a scheme, a host and a port, and refuses a url
with a path. It takes `https://`, or `http://` to the client's own
machine, `localhost`, `127.0.0.1` or `[::1]`, as in development. It
follows no redirect, since a redirect would take it to another origin than
the one it trusts on first contact.

After first contact the service is its identity. `of` gives the Service of
an identity that the store holds with the latest `at`, whichever channel
brought it, and reaches nothing:

```ts
const service = await services.of(account.service.link);
```

Another device that syncs the store goes back to the service that way, and
to where it moved, once the store holds the newer Service. `of` checks a
Service it reads from the store as `at` does, save that no origin was
asked: its origin is still to be one that `at` takes. It reads every
Service in the store, through an index of `@estoc/store`.

## Opening an account

An identity has an account at a service, one for each identity, and opens
it by signing the service's offer. The identity is the account's key: the
service hands out no secret to keep, and whoever signs as the identity
reaches the account from any device.

A service has an identity of its own. It signs one offer, which names that
identity, so each service's offer has a link of its own, and a signature
that accepts one service's offer accepts no other's. An account offer that
names another identity than the one that signed it is refused.

Opening an account is accepting the offer: an identity signs it, and the
account is the account of whoever signed. A wallet asks its holder to
confirm each signature, so the wallet can instead authorize a key on the
device with `@estoc/authorization`, and the device signs a Proxy for the
offer. The account is still the wallet's.

`accept` takes an actor of `@estoc/authorization`, and opens the account of
its principal:

```ts
const account = await service.account.accept(authorizations.createActor(wallet));
// or, for the wallet, by a key on the device that it authorized:
const account = await service.account.accept(authorizations.createActor(deviceKey, [grant]));
```

The actor signs the offer, or a proxy for it, and `accept` posts the
bundle of that signature to `POST /<id>`, at the id that the Service lists
with the offer: the signature as the root, with the identity, and for a
proxy the Proxy and its chain. The offer and the schemas are left out,
since the service has them.

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
service answers with the acknowledgement it sent when the account opened,
as long as the acceptance stands the identity behind the offer by the
service's clock then: one through an authorization that has ended since is
refused like any other. That acknowledgement links to the first acceptance, so a second device
gets the first device's proxy and chain with it. The client reads the
acceptance at the acknowledgement's `at`, when the service received it,
since an authorization in its chain may have ended since, and refuses an
acknowledgement that is signed by another identity than the service's or
that is of another identity's account.

The service signed the offer and the acknowledgement, and the identity
signed the offer, so together they show anyone that this service opened an
account for this identity.

### What the client keeps

`at` writes the service's signature over the Service, which leads to the
offers and the service's signatures over them, and `accept` writes the
service's signature over the acknowledgement, each to the store as mine,
with all they lead to. Another device that syncs the store learns which
services the identity has accounts at, by their identities, and where
they are, without asking them. When the service refuses, or its answer is
refused, `accept` writes nothing.

`accept` gives the `Account`: the identity whose account it is, the
service's identity, `at`, and the link of the service's signature over the
acknowledgement.

## The service

```ts
import { loadMailboxService, MemoryAccounts, MemoryRegistry } from "@estoc/mailbox-service/server";

const service = await loadMailboxService(serviceKey, {
  origin: "https://mail.example",
  store,
  accounts: new MemoryAccounts(),
  registry: new MemoryRegistry(),
  validator: defaultValidator,
});
export default { fetch: (request: Request) => service.fetch(request) };
```

`loadMailboxService` takes the signer of the service's identity and the
origin it is reached at. The origin is set there rather than read from a
request, whose host is the requester's to choose. It signs the offer and a
Service at that origin that lists the offer with a new id, and writes the
signature over the Service to `store`, a store of `@estoc/store`, with all
it leads to. Each acknowledgement it signs is written there too, as the
service's own, with the acceptance and all it leads to, and what the bundle
of an acceptance holds besides is dropped.

`registry` keeps what the service gave out: each id, with the offer whose
acceptances it takes, and the link of the service's signature over the
Service it answers `GET /` with. Started again with the same registry and
store, the service answers with the same Service when the origin and the
offer are as they were. At another origin it signs a new Service, with a
later `at`, that keeps the signature over the offer and its id, so what a
client holds still holds. An id whose offer the service no longer makes
is answered 410, and `add` refuses an id that the registry holds already,
so none is given out twice. `MemoryRegistry` keeps it in memory.

`accounts` holds one row for each identity: the link of the identity, and
the link of the service's signature over the acknowledgement of its
account. Its `add` keeps a row only for an identity without one, in one
step, so two acceptances of one identity that arrive together open one
account. `MemoryAccounts` keeps the rows in memory.

`fetch` takes a `Request` and gives a `Response`, as a fetch handler does.
It answers `GET /` and `POST /<id>`, 404 at an id it did not give out and
at any other path, and 410 at an id whose offer it no longer makes. No
request carries credentials, so it answers any origin, and it answers the
CORS preflight that a browser sends before it posts a zip to another
origin. A body is read up to 64 KiB.

Bundles travel both ways packed, as `packBundle` of `@estoc/bundle` packs
them, and are read with `unpackBundle`, so a small body cannot unzip to
much more than arrived.

A service opens no account for its own identity: a signature of its own
over its offer accepts nothing.
