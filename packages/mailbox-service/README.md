# @estoc/mailbox-service

A mailbox service keeps messages for receivers who are not online. It is
the receiving side of an HTTP mailbox of `@estoc/mailbox`: a receiver
writes a url at the service into a mailbox, and senders post there as they
post to any HTTP mailbox. This package reaches such a service and opens
accounts there, and no more: its handler answers where the service is and
the acceptance of its offer, and receives no messages.

## Addressing

A service is named by the root of its identity. Its origin is where the
service is reached for now, and it says so by signing a Service: at `at` it
is at `origin`, and makes these offers. What the service gives out, its
Services and its acknowledgements, is signed by its identity, so a client
goes by who signed it, not by where the bytes came from; TLS keeps them
private, and vouches for the service on first contact alone. A refusal is
plain text, and a client keeps nothing of it.

Of the Services that identities of one root signed, the latest says where
the service is now:
the one with the greatest `at`, and of those with the same `at`, the one
whose signature has the greater link, compared as ASCII strings. Services
started at once can sign the same `at`, and every reader takes the same one
of them for the latest, whatever order its store took them in.

What a client posts to, the service gives it: each offer in a Service comes
with an id, and the address is the origin and the id, `<origin>/<id>`.
That is the one rule for making a url. An id names one thing for good: once
what it names ends, the service answers 410 there, and the id names nothing
else. The id of an offer is the offer's link, so it is the same wherever
the service is and however often it starts. A request names the object it
acts on by link, so where the service moves, neither a request nor a
signature changes.

```
Service          {"origin": <origin>, "at": <milliseconds>, "offers": [{"offer": <link of the service's signature over the offer>, "accept": <link of the offer>}, …]}, signed by the service
Account offer    {"identity": <link of the service's root>}, signed by the service
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
offer signed by an identity of another root. It writes the service's
signature over the Service to the store as mine, with all it leads to, and
gives a `Service`: the service's signed identity that signed it, its
origin, `at`, the link of the signature, and `account`, the offer of an
account when the Service lists one. Offers of schemas the client does not
read are passed over.

`at` takes an origin alone, a scheme, a host and a port, and refuses a url
with a path. It takes `https://`, or `http://` to the client's own
machine, `localhost`, `127.0.0.1` or `[::1]`, as in development. It
follows no redirect, since a redirect would take it to another origin than
the one it trusts on first contact.

After first contact the service is its root. `of` gives the latest
Service that the store holds of the root that signed a signed identity,
whichever channel brought it, and reaches nothing:

```ts
const service = await services.of(account.service);
```

Another device that syncs the store goes back to the service that way, and
to where it moved, once the store holds the newer Service. `of` checks a
Service it reads from the store as `at` does, save that no origin was
asked: its origin is still to be one that `at` takes. It reads every
Service in the store, through an index of `@estoc/store`.

## Opening an account

An identity has an account at a service, one for each root, and opens it
by signing the service's offer. The account is found by the identity's
root: the service hands out no secret to keep, and whoever signs as an
identity of that root reaches the account from any device.

A service has an identity of its own. It signs one offer, which names the
root of that identity, so each service's offer has a link of its own, and a
signature that accepts one service's offer accepts no other's. An account
offer that names another root than that of the identity that signed it is
refused.

Opening an account is accepting the offer: an identity signs it, and the
account is the account of its root. A wallet asks its holder to confirm
each signature, so the wallet can instead list a key on the device in a
Delegated Identity of `@estoc/identity`, and the device signs the offer for
it. The account is still the wallet's.

`accept` takes an actor of `@estoc/identity`, for the wallet's own Identity
or for one that lists the device's key, and opens the account of its
identity's root:

```ts
const account = await service.account.accept(signatures.actor(wallet, await publish(wallet)));
// or, for the wallet, by a key on the device that it lists:
const account = await service.account.accept(signatures.actor(device, await delegate(wallet, [device.key])));
```

The actor signs the offer, and `accept` posts the bundle of that signature
to `POST /<id>`, at the id that the Service lists with the offer: the
signature as the root, with the blobs of its signed identity. The offer and
the signature schema are left out, since the service has them.

The service reads the signature at the bundle's root with
`signatures.read`, by the people it knows, refuses it unless it is over
the offer, opens an account for the root of its identity unless the root
has one, and answers with its signature over an acknowledgement of the
bundle's root. `at` is when it received that. The answer is a bundle: the
service's signature as the root, with the acknowledgement, the acceptance,
the offer and all they lead to.

| Status | Meaning |
|---|---|
| 201 | the account opened; the answer is the acknowledgement of this acceptance |
| 200 | the identity's root had an account; the answer is the acknowledgement of this acceptance |
| 400 | the bundle does not read, or its root is not a signature over this service's offer by a key that the current version of its identity lists |
| 413 | the body is over 64 KiB |

A root has one account at a service. When an identity of a root that has
an account accepts again, by another device or another identity, the
service answers 200 with an acknowledgement of that acceptance. When the
same acceptance comes again, and the store holds an acknowledgement of it,
the service answers with that one. Requests of one acceptance that arrive
together, as when a client tries again before it hears back, can each
sign an acknowledgement of it, and each answer acknowledges that
acceptance. Of more than one, the service answers with the one whose
signature has the least link, compared as ASCII strings, so services that
share a store answer alike. Either way a device gets an acknowledgement of
its own acceptance. The client refuses an
acknowledgement that is signed by another root than the service's or that
acknowledges another acceptance than the one it sent.

The service knows people by what it gave out: the versions that signed its
Services and its acknowledgements, and those that the acceptances it
acknowledged carry. Each acceptance it takes is acknowledged, so the
version it carries counts from then on. A wallet takes a device out by
signing a later version of its identity that does not list it, and the
service refuses an acceptance by an agent that the current version does
not list: the later of the latest it knows and the one the acceptance
carries. It judges that first, so a removed device is refused even when the
wallet has an account, and even for an acceptance that the service
acknowledged before. Say the wallet's first version lists a laptop and its
second only a phone: once the phone has accepted by the second, the
laptop's acceptance by the first is refused, whichever of them opened the
account. What a removed key signed stops counting for a reader that knows
of the later version; what has to keep counting is signed again by a key
that the current version lists. Two acceptances that open one account at
once are both acknowledged, and one of them is answered 201, the other 200.

The service signed the offer and the acknowledgement, and the identity
signed the offer, so together they show anyone that this service took this
identity's acceptance of its offer.

### What the client keeps

`at` writes the service's signature over the Service, which leads to the
offers and the service's signatures over them, and `accept` writes the
service's signature over the acknowledgement, each to the store as mine,
with all they lead to. Another device that syncs the store learns which
services the identity has accounts at, by their roots, and where they
are, without asking them. When the service refuses, or its answer is
refused, `accept` writes nothing.

The client knows people as the service does, from the same records in its
store: the versions that signed the Services and the acknowledgements, and
those that the acknowledged acceptances carry. `at`, `of` and `accept` read
the service's signatures by them, so a Service, an offer or an
acknowledgement signed by a key that a later version of the service's
identity does not list is refused once the store knows that version.

A Service vouches for the offers it lists by the version that signed it,
which the store knows once it keeps the Service. So an offer is read by
the later of that version and the latest the store knows, not by the
version its own signature carries, and `at` refuses a Service whose
offers `of` would refuse once the store keeps it. A service that signs a
Service by a version that does not list the key that signed an offer
signs the offer again by a key that the version lists. The offer stays
the same object, so its id and the acceptances of it stay as they were.

`accept` gives the `Account`: the actor's signed identity, whose root the
account is of, the service's signed identity that signed the
acknowledgement, `at`, when the service received this acceptance, and the
link of the service's signature over the acknowledgement.

## The service

```ts
import { loadMailboxService, MemoryAccounts } from "@estoc/mailbox-service/server";

const service = await loadMailboxService(serviceKey, {
  origin: "https://mail.example",
  store,
  accounts: new MemoryAccounts(),
  validator: defaultValidator,
});
export default { fetch: (request: Request) => service.fetch(request) };
```

`loadMailboxService` takes the signer of the service's identity and the
origin it is reached at. The origin is set there rather than read from a
request, whose host is the requester's to choose. Started with an empty
store, it has the signer sign the service's identity, then the offer and a
Service at that origin that lists the offer under its link, and writes the
signature over the Service to `store`, a store of `@estoc/store`, as the
service's own, with all it leads to. Started with a store that holds a
Service of its, it signs as the signed identity that the latest Service
names, and the signer does not sign the identity again. Each
acknowledgement it signs is written there too, as the service's own, with
the acceptance and all it leads to, and what the bundle of an acceptance
holds besides is dropped.

The Services in the store are what the service gave out. Of them, the
latest is the one it answers `GET /` with, as a client takes it for where
a service is, and the ids they list are the ids it gave out: one that the
latest lists takes acceptances, one that only an earlier one lists is
answered 410, and one that none lists 404. The service
works this out from the store on each request, through the same index of
`@estoc/store` that `of` reads, so services that share a store answer
alike, with the latest Service that any of them signed.

Started again with the same store, the service keeps answering with the
latest Service when what it would sign says the same apart from `at`: the
same origin and the same offers. At another origin it signs a new Service,
which lists the offer under the same id with the same signature over it,
so what a client holds still holds. The new Service's `at` is the time the
service's clock gives, and the clock is the service's to keep: started with
its clock behind, it signs a Service earlier than the one before, which
stays the latest. Two started at once on one store can sign the
same `at`, and the latest of the two is then the one whose signature has
the greater link.

`accounts` holds one row for each root: the link of the root of an
identity, and the link of the service's signature over the acknowledgement
of the acceptance that opened its account. Its `add` keeps a row only for a
root without one, in one step, so two acceptances of one root that arrive
together open one account, and the service answers 201 to the acceptance
whose row was kept and 200 to any other. `MemoryAccounts` keeps the rows in
memory.

`fetch` takes a `Request` and gives a `Response`, as a fetch handler does.
It answers `GET /` and `POST /<id>`, 404 at an id it did not give out and
at any other path, and 410 at an id that only an earlier Service lists. No
request carries credentials, so it answers any origin, and it answers the
CORS preflight that a browser sends before it posts a zip to another
origin. A body is read up to 64 KiB.

Bundles travel both ways packed, as `packBundle` of `@estoc/bundle` packs
them, and are read with `unpackBundle`, so a small body cannot unzip to
much more than arrived.

A service opens no account for its own root: a signature of its own over
its offer accepts nothing.
