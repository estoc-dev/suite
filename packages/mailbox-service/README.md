# @estoc/mailbox-service

A mailbox service keeps messages for receivers who are not online. It is
the receiving side of an HTTP mailbox of `@estoc/mailbox`: a receiver
writes a url at the service into a mailbox, and senders post there as they
post to any HTTP mailbox. This package reaches such a service, opens
accounts and mailboxes there, and picks up what waits at them; its handler
is the service.

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
the service is and however often it starts. The ids of a mailbox are made
up when it opens, 16 random bytes in lowercase hex. A request names the
object it acts on by link, so where the service moves, neither a request
nor a signature changes.

```
Service                  {"origin": <origin>, "at": <milliseconds>, "offers": [{"offer": <link of the service's signature over the offer>, "accept": <link of the offer>}, …]}, signed by the service
Account offer            {"identity": <link of the service's root>}, signed by the service
Acknowledgement          {"accepted": <link of the signature over the offer>, "at": <milliseconds>}, signed by the service
Mailbox offer            {"identity": <link of the service's root>, "retention": <milliseconds>, "quota": <bytes>, "size": <bytes>}, signed by the service
Mailbox request          {"offer": <link of the mailbox offer>, "key": <x25519 public key>}, signed by an identity with an account
Mailbox acknowledgement  {"accepted": <link of the signature over the request>, "at": <milliseconds>, "send": <id>, "pickup": <id>}, signed by the service
Pickup request           {"mailbox": <link of the service's signature over the mailbox acknowledgement>, "done": [<link of sealed bytes>, …]}, signed by an identity of the account
Waiting                  {"sealed": [<link of sealed bytes>, …]}, unsigned
```

All are objects of `@estoc/object`, written to fixed draft 2020-12 schemas,
`serviceSchema`, `accountOfferSchema`, `acknowledgementSchema`,
`mailboxOfferSchema`, `mailboxRequestSchema`,
`mailboxAcknowledgementSchema`, `pickupRequestSchema` and `waitingSchema`,
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
origin, `at`, the link of the signature, `account`, the offer of an account
when the Service lists one, and `mailbox`, the offer of mailboxes when it
lists one. Offers of schemas the client does not read are passed over.

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
Services and its acknowledgements, and those that the acceptances and the
requests for mailboxes it acknowledged carry. Each acceptance it takes is
acknowledged, so the version it carries counts from then on. A wallet takes a device out by
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
offers and the service's signatures over them, and `accept` and `open`
write the service's signature over the acknowledgement, each to the store
as mine, with all they lead to. Another device that syncs the store learns
which services the identity has accounts and mailboxes at, by their roots,
and where they are, without asking them. When the service refuses, or its
answer is refused, `accept` and `open` write nothing.

The client knows people as the service does, from the same records in its
store: the versions that signed the Services and the acknowledgements, and
those that the acknowledged acceptances and requests carry. `at`, `of` and `accept` read
the service's signatures by them, so a Service, an offer or an
acknowledgement signed by a key that a later version of the service's
identity does not list is refused once the store knows that version.

`at` reads the Service, and `accept` the acknowledgement, on the store as
it will be once that is written, as `stage` of `@estoc/store` gives it. So
a Service that `at` takes reads alike by `of` until the store knows a later
version of the service's identity. The offers a Service lists are read as
any signature is, and the store then knows the version that signed the
Service, so an offer is read by that version or a later one. When a
service signs a Service by a version that takes out the key that signed an
offer by an earlier one, it signs the offer again by a key that the version
lists. The offer stays the same object, so its id and the acceptances of it
stay as they were.

`accept` gives the `Account`: the actor's signed identity, whose root the
account is of, the service's signed identity that signed the
acknowledgement, `at`, when the service received this acceptance, and the
link of the service's signature over the acknowledgement.

## Opening a mailbox

A mailbox opens under an account. An identity of a root that has an
account signs a request for one, which names the service's offer of
mailboxes and the key that messages to the mailbox are sealed to. The
service answers with its signature over an acknowledgement of the request,
which names two ids it made up: `send`, which senders post to, and
`pickup`, which the account picks up at. Neither tells the other, and a
sender, who holds the send id alone, learns nothing of the account.

Each mailbox has a key of its own, so each request is one of its own too,
and one account opens as many mailboxes as it asks for. The same request
posted again is answered with the same acknowledgement, so a client that
did not hear back posts it again.

`open` takes an actor, as `accept` does, and the public key of a
`MailboxKey` of `@estoc/mailbox`, so it is what `Post.openInbox` is given:

```ts
const inbox = await post.openInbox((publicKey) => service.mailbox.open(actor, publicKey));
```

The actor signs the request, and `open` posts the bundle of that signature
to `POST /<id>`, at the id that the Service lists with the offer: the
signature as the root, with the request and the blobs of its signed
identity. It writes the service's signature over the acknowledgement to
the store as mine, with all it leads to, and gives the HTTP mailbox of
`@estoc/mailbox` that senders post to, `{"key", "url"}`, whose url is the
origin the offer was taken at and the send id. `Post.openInbox` writes the
mailbox to the store, and its key to the private store. The client refuses
an acknowledgement as `accept` does, and writes nothing then.

The offer names the terms of the mailboxes it opens: what waits is kept
for `retention` milliseconds, a mailbox holds at most `quota` bytes that
wait, and a message is at most `size` bytes. `terms` gives them. Other
terms are another offer, which a new Service lists, and a mailbox keeps
the terms of the offer that opened it.

The service reads the signature over the request as it reads an
acceptance, by the people it knows, and refuses it when its root has no
account.

| Status | Meaning |
|---|---|
| 201 | the mailbox opened; the answer is the acknowledgement of this request |
| 200 | this request opened a mailbox before; the answer is its acknowledgement |
| 400 | the bundle does not read, or its root is not a signature over a request for this service's offer by a key that the current version of its identity lists |
| 403 | the root of the identity has no account |
| 413 | the body is over 64 KiB |

Requests of one mailbox that arrive together can each sign an
acknowledgement, and one of them opens the mailbox. Each is answered with
the acknowledgement of the one that opened it, which is answered 201, and
any other 200.

## Sending to a mailbox

Senders post to the mailbox as to any HTTP mailbox, at its url,
`POST /<send id>`, with the sealed bytes as the body. Whoever holds the
mailbox can.

| Status | Meaning |
|---|---|
| 204 | the sealed bytes wait at the mailbox |
| 404 | no mailbox has this id |
| 413 | the sealed bytes are over the size that the offer names |
| 429 | with them, what waits would come to more than the quota; more is taken once some is picked up |

What waits stays until a pickup is done with it, or for the retention that
the offer names, after which it no longer waits and no longer counts
toward the quota. Sealed bytes that arrive while the same wait, wait once.
A sender of `@estoc/mailbox` turns back a 404 as `gone`, a 429 as `later`
and a 413 as `refused`.

## Picking up

`pickup` gives what waits at a mailbox that the store holds, as a `Pickup`
of `@estoc/mailbox`, for an inbox to collect:

```ts
const delivered = await inbox.collect(await services.pickup(inbox.mailbox, actor));
```

The actor is any of the root of the account. The service judges each
pickup by the current version of the root's identity, as it judges an
acceptance: an agent that the root lists picks up without opening the
mailbox again, and one that a later version takes out picks up no more
once the service knows that version, from an acceptance or a request that
it acknowledges. Opening what arrives takes the mailbox's key, which
`Post.openInbox` keeps in the private store of the device that opened the
mailbox.

`pickup` finds the acknowledgement of the mailbox that the store holds,
through an index of `@estoc/store`, by the send id at the end of the
mailbox's url and by the mailbox's key. It picks up at the pickup id, at
the origin of the latest Service of the service that the store holds, so
at wherever the service moved. Senders still post to the url that the
mailbox names.

Each request is a pickup request that the actor signs. It names the
mailbox by the service's signature over the acknowledgement, and lists by
link the sealed bytes that the receiver was done with since the request
before. The service lets those wait no more, and answers with a bundle
whose root is a Waiting, unsigned, which lists by link what waits, the
earliest first, with those bytes: 100 at most, coming to 1 MiB at most,
but one at least however large. `arrivals` hands out each that it has not
handed out yet, and once it handed out an answer, asks again. It ends once
an answer brings nothing that it has not handed out, and once the signal
aborts. What the receiver is done with once the last request is sent
still waits, and is picked up again. A request posted again drops what
was dropped before and answers with what waits now, which only the
mailbox's key opens: whoever posts it again sees how much waits, and no
more.

| Status | Meaning |
|---|---|
| 200 | the answer is what waits, once what the request is done with no longer does |
| 400 | the bundle does not read, or its root is not a signature over a pickup request of this mailbox |
| 403 | the request is signed for another root than the account's, or by a key that the current version of the root's identity does not list |
| 413 | the body is over 64 KiB and 128 bytes for each of the 100 messages that an answer holds at most |

Devices that pick up at once each get what waits, so each receives it, as
a receiver that picks up again does.

## The service

```ts
import { loadMailboxService, MemoryAccounts, MemoryMailboxes } from "@estoc/mailbox-service/server";

const service = await loadMailboxService(serviceKey, {
  origin: "https://mail.example",
  store,
  accounts: new MemoryAccounts(),
  mailboxes: new MemoryMailboxes(),
  terms: { retention: 30 * 24 * 60 * 60 * 1000, quota: 64 * 1024 * 1024, size: 1024 * 1024 },
  validator: defaultValidator,
});
export default { fetch: (request: Request) => service.fetch(request) };
```

`loadMailboxService` takes the signer of the service's identity and the
origin it is reached at. The origin is set there rather than read from a
request, whose host is the requester's to choose. Started with an empty
store, it has the signer sign the service's identity, then the offer of an
account, the offer of mailboxes on `terms`, and a Service at that origin
that lists each offer under its link, and writes the signature over the
Service to `store`, a store of `@estoc/store`, as the service's own, with
all it leads to. Started with a store that holds a
Service of its, it signs as the signed identity that the latest Service
names, and the signer does not sign the identity again. Each
acknowledgement it signs is written there too, as the service's own, with
the acceptance or the request and all it leads to, and what the bundle
holds besides is dropped.

The Services in the store are what the service gave out. Of them, the
latest is the one it answers `GET /` with, as a client takes it for where
a service is, and the ids they list are the ids it gave out: one that the
latest lists takes what is posted for the offer under it, one that only an
earlier one lists is answered 410, and one that none lists 404. The
service works this out from the store on each request, through the same
index of `@estoc/store` that `of` reads, and reads the offer there too, so
services that share a store answer alike, with the latest Service that any
of them signed, and open mailboxes on the terms that it lists.

Started again with the same store, the service keeps answering with the
latest Service when what it would sign says the same apart from `at`: the
same origin and the same offers. At another origin it signs a new Service,
which lists the offers under the same ids with the same signatures over
them, so what a client holds still holds. With other terms it signs
another offer of mailboxes, which the new Service lists in place of the
one before, whose id is then answered 410. The new Service's `at` is the time the
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
whose row was kept and 200 to any other. Its `has` says whether a root has
an account, which opening a mailbox asks. `MemoryAccounts` keeps the rows
in memory.

`mailboxes` holds the mailboxes the service opened, each with the request
that opened it, the link of the service's signature over its
acknowledgement, the root of its account, its two ids and its terms, and
the sealed bytes that wait at each. Its `open` keeps a mailbox only for a
request without one, in one step, so requests of one mailbox that arrive
together open one. Its `put` keeps sealed bytes unless what waits would
then come to more than the quota, in one step. The service passes it
`since`, the time that the retention reaches back to, and what was
received before then waits no more. `MemoryMailboxes` keeps them in
memory.

`fetch` takes a `Request` and gives a `Response`, as a fetch handler does.
It answers `GET /` and `POST /<id>`, 404 at an id it did not give out and
at any other path, and 410 at the id of an offer that only an earlier
Service lists. No request carries credentials, so it answers any origin,
and it answers the CORS preflight that a browser sends before it posts a
zip or sealed bytes to another origin. A request is read up to 64 KiB. A
pickup request is read up to 128 bytes more for each of the 100 messages
that an answer holds at most, so that it lists the links of all that the
receiver is done with of the answer before. Sealed bytes are read up to the
size that the offer of their mailbox names.

Bundles travel both ways packed, as `packBundle` of `@estoc/bundle` packs
them, and are read with `unpackBundle`, so a small body cannot unzip to
much more than arrived.

A service opens no account for its own root: a signature of its own over
its offer accepts nothing.
