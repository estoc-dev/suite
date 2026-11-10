# @estoc/mailbox-service

A mailbox service keeps messages for receivers who are not online. It is
the receiving side of an HTTP mailbox of `@estoc/mailbox`: a receiver
writes a url at the service into a mailbox, and senders post there as they
post to any HTTP mailbox. This package reaches such a service, opens
accounts and mailboxes there, and picks up what waits at them; its handler
is the service.

## Addressing

A service is named by the identifier of its identity, as anyone who signs
is in `@estoc/identity`. Its origin is where the service is reached for
now, and it says so by signing a Service: at `at` it is at `origin`, and
makes these offers. What the service gives out, its Services and its
acknowledgements, is signed by its identity, so a client goes by who signed
it, not by where the bytes came from; TLS keeps them private, and vouches
for the service on first contact alone. A refusal is plain text, and a
client keeps nothing of it.

Of the Services that identities of one identifier signed, a reader honors
those whose signatures are honored by the identity versions it holds, as
`honors` of `@estoc/identity` says, and the latest of them says where the
service is now: the one with the greatest `at`, and of those with the same
`at`, the one whose signature has the greater link, compared as ASCII
strings. A Service signed by a key that a later identity version takes out
is no longer honored, whatever its `at`, so whoever still holds that key
does not say where the service is. Once the root signs a crisis, a Service
is honored only when the identity version that signed it is the crisis or
follows it, so one that the root itself signed before, or on another branch
however late, is no longer honored. Services started at once can sign the same `at`, and every reader takes the same one
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
Service                  {"origin": <origin>, "at": <milliseconds>, "offers": [{"offer": <link of the service's signature over the offer>, "acceptId": <link of the offer>}, …]}, signed by the service
Account offer            {"identity": <the service's identifier>}, signed by the service
Acknowledgement          {"acceptance": <link of the signature over the offer>, "at": <milliseconds>}, signed by the service
Mailbox offer            {"identity": <the service's identifier>, "retention": <milliseconds>, "quota": <bytes>, "size": <bytes>}, signed by the service
Mailbox request          {"offer": <link of the mailbox offer>, "key": <x25519 public key>}, signed by an identity with an account
Mailbox acknowledgement  {"request": <link of the signature over the request>, "at": <milliseconds>, "sendId": <id>, "pickupId": <id>}, signed by the service
Pickup request           {"mailbox": <link of the signature over the mailbox request>, "receipts": [<link of a ciphertext>, …]}, signed by an identity of the account
Pickup answer            {"ciphertexts": [<link of a ciphertext>, …]}, unsigned
```

All are objects of `@estoc/object`, written to fixed draft 2020-12 schemas,
`serviceSchema`, `accountOfferSchema`, `acknowledgementSchema`,
`mailboxOfferSchema`, `mailboxRequestSchema`,
`mailboxAcknowledgementSchema`, `pickupRequestSchema` and `pickupAnswerSchema`,
which the client and the service share. The client is
`@estoc/mailbox-service`, and the service `@estoc/mailbox-service/server`.

An offer names no origin and no id. It is what an identity signs to accept
it, so it stays one object, with one link, wherever the service is reached.

## Reaching a service

```ts
import { ed25519, eip191 } from "@estoc/identity";
import { loadServices } from "@estoc/mailbox-service";
import { defaultValidator } from "@estoc/object/default-validator";

const services = await loadServices(store, { validator: defaultValidator, schemes: [ed25519, eip191] });
const service = await services.fetch("https://mail.example");
```

`fetch` gets the Service at an origin, from `GET /`: a bundle with the
service's signature over the Service as the root, and the offers it lists,
the service's signatures over them, the service's identity and their
schemas. What the origin answers over TLS is the service's, so `fetch` takes
the identity that signed the Service as the service's, and refuses a
Service that names another origin than the one asked, or that lists an
offer signed for another identifier. It keeps the bundle in the
store with an `Inbound` record of `@estoc/store`, and gives a `Service`:
the service's signed identity that signed it, its
origin, `at`, the link of the signature, `account`, the offer of an account
when the Service lists one, and `mailbox`, the offer of mailboxes when it
lists one. Offers of schemas the client does not read are passed over.
`schemes` are the schemes of `@estoc/identity` the client reads keys in, a
service's and its user's alike.

`fetch` takes an origin alone, a scheme, a host and a port, and refuses a url
with a path. It takes `https://`, or `http://` to the client's own
machine, `localhost`, `127.0.0.1` or `[::1]`, as in development. It
follows no redirect, since a redirect would take it to another origin than
the one it trusts on first contact.

After first contact the service is its identifier. `latestOf` gives the
latest Service that the store holds of the person of a signed identity,
whichever channel brought it, or `undefined` when none is honored, and reaches
nothing:

```ts
const service = await services.latestOf(account.service);
```

Another device that syncs the store goes back to the service that way, and
to where it moved, once the store holds the newer Service. `latestOf` checks a
Service it reads from the store as `fetch` does, save that no origin was
asked: its origin is still to be one that `fetch` takes. It reads every
Service that the store holds, through an index over blobs of
`@estoc/store`, so a Service that came in at a mailbox is honored as one that
`fetch` got: what makes it the service's is the signature.

## Opening an account

An identity has an account at a service, one for each identifier, and
opens it by signing the service's offer. The account is found by the
identity's identifier: the service hands out no secret to keep, and whoever
signs as an identity of that identifier reaches the account from any
device.

A service has an identity of its own. It signs one offer, which names the
service by its identifier, so each service's offer has a link of its own,
and a signature that accepts one service's offer accepts no other's. An
account offer that names another identifier than that of the identity that
signed it is refused.

Opening an account is accepting the offer: an identity signs it, and the
account is the account of its identifier. A wallet asks its holder to confirm
each signature, so the wallet can instead list a key on the device as an
agent of its identity of `@estoc/identity`, and the device signs the offer
for it. The account is still the wallet's.

`accept` takes an actor of `@estoc/identity`, for the wallet itself or for
the device's key that its identity lists, and opens the account of its
identity's identifier:

```ts
const account = await service.account.accept(signatures.actor(wallet, await publish(wallet)));
// or, for the wallet, by a key on the device that it lists:
const account = await service.account.accept(signatures.actor(device, await publish(wallet, { agents: [device.key] })));
```

The actor signs the offer, and `accept` posts the bundle of that signature
to `POST /<id>`, at the id that the Service lists with the offer: the
signature as the root, with the blobs of its signed identity. The offer and
the signature schema are left out, since the service has them.

The service reads the signature at the bundle's root with `signatures.read`,
against the identity versions it holds, refuses it unless it is over the
offer, opens an account for the identifier of its identity unless that
has one, and answers with its signature over an acknowledgement of the bundle's
root. `at` is when it received that. The answer is a bundle: the service's
signature as the root, with the acknowledgement, the acceptance, the offer
and their closure.

| Status | Meaning |
|---|---|
| 201 | the account opened; the answer is the acknowledgement of this acceptance |
| 200 | the identity's identifier had an account; the answer is the acknowledgement of this acceptance |
| 400 | the bundle does not read, or its root is not a signature over this service's offer that is honored by the identity versions the service holds |
| 413 | the body is over 64 KiB |

An identifier has one account at a service. When an identity of an
identifier that has an account accepts again, by another device or another identity, the
service answers 200 with an acknowledgement of that acceptance. When the
same acceptance comes again, and the store holds an acknowledgement of it,
the service answers with that one while the service's signature over it
is honored. Once a crisis of the service's root cuts that signature, the
service signs the same acknowledgement again, as its current identity
version, and answers with that. Requests of one acceptance that arrive
together, as when a client tries again before it hears back, can each
sign an acknowledgement of it, and each answer acknowledges that
acceptance. Of more than one, the service answers with the one whose
signature has the least link, compared as ASCII strings, so services that
share a store answer alike. Either way a device gets an acknowledgement of
its own acceptance. The client refuses an
acknowledgement that is signed for another identifier than the service's or
that acknowledges another acceptance than the one it sent.

The identity versions the service holds are the signed identities in its
store, which it reads by their schema. The store keeps what the service gave
out, with its closure, so these are the identity versions that signed its
Services and its acknowledgements, and those that the acceptances and the
requests for mailboxes it acknowledged carry. Each acceptance it takes is
acknowledged, so the identity version it carries counts from then on. A
wallet takes a device out by signing a later identity version that does not
list it, and the service refuses an acceptance by an agent that the current
identity version does not list: the latest that counts of those it has seen
and of the one the acceptance carries with those it follows. It verifies that first, so a removed device is
refused even when the wallet has an account, and even for an acceptance that
the service acknowledged before. Say the wallet's first identity version
lists a laptop and its second only a phone: once the phone has accepted by
the second, the laptop's acceptance by the first is refused, whichever of
them opened the account. What a removed key signed is no longer honored by
a reader that has seen the later identity version; what has to stay honored
is signed again by a key that the current identity version lists. A crisis
takes out more: once the service has seen one, it refuses an acceptance
signed by an identity version that is neither the crisis nor one that
follows it, by the root as by an agent, however late its `at`. Two acceptances
that open one account at once are both acknowledged, and one of them is
answered 201, the other 200.

The service signed the offer and the acknowledgement, and the identity
signed the offer, so together they show anyone that this service took this
identity's acceptance of its offer.

### What the client keeps

What a service answers comes from outside the store, so the client keeps it
as `@estoc/store` keeps all such: `fetch` keeps the service's signature over
the Service, whose closure holds the offers and the service's signatures
over them, and `accept` and `open` keep the service's signature over the
acknowledgement, each with an `Inbound` record whose `via` is the origin it
came from:

```
Origin  {"origin": <origin>}
```

The origin is an object of its own, written to `originSchema`, so one
origin is one object however often it is reached. `via` records where
something came from, and nothing reads it to decide anything. `loadServices`
takes a `clock` for the `at` of the records, `Date.now` unless given. When the
service refuses, or its answer is refused, `fetch`, `accept` and `open` write
nothing.

What the client reads back of where services are, it reads from the
signatures the store holds, records or not, by who signed them, as it reads
identity versions. A Service that came in at a mailbox, or that another
device fetched, reads as one that came from the service here. Another device
that syncs the store learns where the services are, by their identifiers,
without asking them.

The mailboxes it opened, it reads back from a record that `open` writes once
the service acknowledged the request, written to `openedMailboxSchema`:

```
Opened mailbox  {"mailbox": <link of the HTTP mailbox>, "acknowledgement": <link of the service's signature over the mailbox acknowledgement>}
```

The record is the user's own, so another device that syncs the store picks
up at the mailbox too. An acknowledgement that came in another way, such as
at a mailbox, opens no mailbox to pick up at, even one that the service
signed of the account's request. A key that a later identity version of
whoever holds the account takes out still signs requests by the identity version
before, so a signature over a request does not tell one sent while the key
was listed from one sent after; the record does.

The client holds identity versions as the service does, as the signed
identities in its store. That store can hold other records than the service
gave out, so it can have seen an identity version that the service has not.
`fetch`, `latestOf` and `accept` verify the service's signatures against
them, so a Service, an offer or an acknowledgement whose signature they do
not honor is refused once the store holds the identity version that
takes it out, however it came: a later one that does not list the key that
signed it, or a crisis that the identity version it carries neither is nor
follows. `latestOf` passes over a Service so signed and takes the latest
that is honored. A service from `loadMailboxService` signs with its root's key,
which each identity version of the root lists, so its signatures are refused
this way only after the root signs a crisis.

`fetch` reads the Service, and `accept` the acknowledgement, on the store as
it will be once that is kept: `stage` of `@estoc/store` gives it with the
bundle's root as a record, and once it reads, the intake keeps the bundle
and the staged batch is dropped. So a Service that `fetch` takes reads alike
by `latestOf` until the store holds an identity version of the service by
which it is no longer honored.
The offers a Service lists are read as any signature is, and the store then
holds the identity version that signed the Service, so an offer is verified
by that identity version or a later one. When a service signs a Service by
an identity version by which its signature over an offer is no longer honored,
as one that takes out the key that signed it, or a crisis, it signs the
offer again by a key that the identity version lists. The offer stays the same object, so its id and the acceptances of it
stay as they were.

`accept` gives the `Account`: the actor's signed identity, whose identifier
the account is of, the service's signed identity that signed the
acknowledgement, `at`, when the service received this acceptance, and the
link of the service's signature over the acknowledgement.

## Opening a mailbox

A mailbox opens under an account. An identity of an identifier that has an
account signs a request for one, which names the service's offer of
mailboxes and the key that messages to the mailbox are sealed to. The
service answers with its signature over an acknowledgement of the request,
which names two ids it made up: `sendId`, which senders post to, and
`pickupId`, which the account picks up at. Neither tells the other, and a
sender, who holds the send id alone, learns nothing of the account.

Each mailbox has a key of its own, so each request is one of its own too,
and one account opens as many mailboxes as it asks for. The same request
posted again is answered with the same acknowledgement, signed again as an
acceptance's is once a crisis of the service's root cuts the signature, so a
client that did not hear back posts it again.

`open` takes an actor, as `accept` does, and the public key of a
`MailboxKey` of `@estoc/mailbox`, so it is what `Post.openInbox` is given:

```ts
const inbox = await post.openInbox((publicKey) => service.mailbox.open(actor, publicKey));
```

The actor signs the request, and `open` posts the bundle of that signature
to `POST /<id>`, at the id that the Service lists with the offer: the
signature as the root, with the request and the blobs of its signed
identity. It keeps the service's signature over the acknowledgement as
`accept` does, and makes the HTTP mailbox of `@estoc/mailbox` that senders
post to, `{"key", "url"}`, whose url is the origin the offer was taken at and
the send id. It writes an Opened mailbox record of the mailbox and the
acknowledgement, and gives the mailbox. `Post.openInbox` writes the mailbox
to the store as a record, and its key to the private store. The client
refuses an acknowledgement as `accept` does, and writes nothing then.

The offer names the terms of the mailboxes it opens: what waits is kept
for `retention` milliseconds, a mailbox holds at most `quota` bytes that
wait, and a message is at most `size` bytes. `terms` gives them. Other
terms are another offer, which a new Service lists, and a mailbox keeps
the terms of the offer that opened it.

The service reads the signature over the request as it reads an acceptance,
against the identity versions it holds, and refuses it when its identifier
has no account.

| Status | Meaning |
|---|---|
| 201 | the mailbox opened; the answer is the acknowledgement of this request |
| 200 | this request opened a mailbox before; the answer is its acknowledgement |
| 400 | the bundle does not read, or its root is not a signature over a request for this service's offer that is honored by the identity versions the service holds |
| 403 | the identifier of the identity has no account |
| 413 | the body is over 64 KiB |

Requests of one mailbox that arrive together can each sign an
acknowledgement, and one of them opens the mailbox. Each is answered with
the acknowledgement of the one that opened it, which is answered 201, and
any other 200.

## Sending to a mailbox

Senders post to the mailbox as to any HTTP mailbox, at its url,
`POST /<send id>`, with the ciphertext as the body. Whoever holds the
mailbox can.

| Status | Meaning |
|---|---|
| 204 | the ciphertext waits at the mailbox |
| 404 | no mailbox has this id |
| 413 | the ciphertext is over the size that the offer names |
| 429 | with it, what waits would come to more than the quota; more is taken once some is picked up |

What waits stays until a pickup has a receipt for it, or for the
retention that the offer names, after which it no longer waits and no
longer counts toward the quota. A ciphertext that arrives while the same
waits, waits once.
A sender of `@estoc/mailbox` turns back a 404 as `gone`, a 429 as `later`
and a 413 as `refused`.

## Picking up

`pickup` gives what waits at a mailbox that the store holds, as a `Pickup`
of `@estoc/mailbox`, for an inbox to collect:

```ts
const delivered = await inbox.collect(await services.pickup(inbox.mailbox, actor));
```

The actor signs for the identifier of the account. The service verifies
each pickup as it verifies an acceptance, by whether the identity versions
of that identifier it holds honor its signature: an agent that the root
lists picks up without opening the mailbox again, and one that a later
identity version takes out, or a crisis cuts off, picks up no more once the
service has seen that identity version, in an acceptance or a request that
it acknowledges. Opening what arrives takes the mailbox's key, which
`Post.openInbox` keeps in the private store of the device that opened the
mailbox.

`pickup` goes by the acknowledgement that the Opened mailbox record of the
mailbox links to, through an index over the records of `@estoc/store`. The
client verified it when `open` kept it, and a later identity version of the
account that takes out the key that signed the request does not change it:
the mailbox stays the account's, and an agent that the root lists picks up
there. It picks up at the pickup id, at the origin of the latest Service
that the store holds of the service that signed the acknowledgement, so at
wherever the service moved. Senders still post to the url that the mailbox
names.

Each request is a pickup request that the actor signs. It names the mailbox
by the signature over the request that opened it, which stays when the
service signs the acknowledgement again, and lists by link, as
receipts, the ciphertexts that the receiver was done with since the request
before. The service lets those wait no more, and answers with a bundle whose
root is a Pickup answer, unsigned, which lists by link what waits, the
earliest first, with those ciphertexts: 100 at most, coming to 1 MiB at
most, but one at least however large. `arrivals` hands out each that it has
not handed out yet, and once it handed out an answer, asks again. It ends
once an answer brings nothing that it has not handed out, and once the
signal aborts. What the receiver is done with once the last request is sent
still waits, and is picked up again. A request posted again drops what was
dropped before and answers with what waits now, which only the mailbox's key
opens: whoever posts it again sees how much waits, and no more.

| Status | Meaning |
|---|---|
| 200 | the answer is what waits, once what the request has receipts for no longer does |
| 400 | the bundle does not read, or its root is not a signature over a pickup request of this mailbox |
| 403 | the request is signed for another identifier than the account's, or its signature is not honored by the identity versions the service holds |
| 413 | the body is over 64 KiB and 128 bytes for each of the 100 messages that an answer holds at most |

Devices that pick up at once each get what waits, so each receives it, as
a receiver that picks up again does.

## The service

```ts
import { ed25519, eip191 } from "@estoc/identity";
import { loadMailboxService, MemoryAccounts, MemoryMailboxes } from "@estoc/mailbox-service/server";

const service = await loadMailboxService(serviceKey, {
  origin: "https://mail.example",
  store,
  accounts: new MemoryAccounts(),
  mailboxes: new MemoryMailboxes(),
  terms: { retention: 30 * 24 * 60 * 60 * 1000, quota: 64 * 1024 * 1024, size: 1024 * 1024 },
  validator: defaultValidator,
  schemes: [ed25519, eip191],
});
export default { fetch: (request: Request) => service.fetch(request) };
```

`loadMailboxService` takes the signer of the service's identity and the
origin it is reached at, and the schemes it reads keys in, its own and
those of whoever signs to it. The origin is set there rather than read from a
request, whose host is the requester's to choose. Started with an empty
store, it has the signer sign the service's identity, then the offer of an
account, the offer of mailboxes on `terms`, and a Service at that origin
that lists each offer under its link, and writes the signature over the
Service to `store`, a store of `@estoc/store`, as a record, with its
closure. Started with a store that holds a Service of its, it signs as its
current identity version, by the identity versions the store holds, and the signer does not sign the identity again. Once the store holds
a crisis of the root, no Service signed before it is honored, so the service
signs its offers and a Service again, as the crisis or one that follows it,
and they list the offers under the same ids. It signs each acknowledgement
as its current identity version by the identity versions the store holds
then. So once another start on the same store has signed a
Service as a crisis of the root, or one that follows it, a service that
started before signs as that identity version without starting again.
While the store holds the crisis and no honored Service, `fetch` throws
for each request until a service starts on the store again. Each
acknowledgement is written there too, as a record, with the acceptance or
the request and its closure, and what the bundle holds besides is dropped.

The Services in the store are what the service gave out. Of those it
honors, the latest is the one it answers `GET /` with, as a client takes it for where
a service is, and the ids they list are the ids it gave out: one that the
latest lists takes what is posted for the offer under it, one that only an
earlier one lists is answered 410, and one that none lists 404. The
service works this out from the store on each request, through the same
index of `@estoc/store` that `latestOf` reads, and reads the offer there too, so
services that share a store answer alike, with the latest Service that any
of them signed, and open mailboxes on the terms that it lists.

Started again with the same store, the service keeps answering with the
latest Service when what it would sign says the same apart from `at`: the
same origin and the same offers. At another origin it signs a new Service,
which lists the offers under the same ids with the same signatures over
them, so what a client holds still holds. With other terms it signs another
offer of mailboxes, which the new Service lists in place of the one before,
whose id is then answered 410. The new Service's `at` is the time the
service's clock gives, and the clock is the service's to keep: started with
its clock behind, it signs a Service earlier than the one before, which
stays the latest. Two started at once on one store can sign the same `at`,
and the latest of the two is then the one whose signature has the greater
link.

`accounts` holds one row for each identifier: the identifier, and the link
of the service's signature over the acknowledgement of the acceptance that
opened its account. Its `add` keeps a row only for an identifier without
one, in one step, so two acceptances of one identifier that arrive together
open one account, and the service answers 201 to the acceptance whose row
was kept and 200 to any other. Its `has` says whether an identifier has an
account, which opening a mailbox asks. `MemoryAccounts` keeps the rows
in memory, and `SqliteAccounts` in a SQLite file.

`mailboxes` holds the mailboxes the service opened, each with the request
that opened it, the link of the service's signature over its
acknowledgement, the identifier of its account, its two ids and its terms, and
the ciphertexts that wait at each. Its `open` keeps a mailbox only for a
request without one, in one step, so requests of one mailbox that arrive
together open one. Its `put` keeps a ciphertext unless what waits would
then come to more than the quota, in one step. The service passes it
`since`, the time that the retention reaches back to, and what was
received before then waits no more. `MemoryMailboxes` keeps them in
memory, and `SqliteMailboxes` in a SQLite file.

`SqliteAccounts` and `SqliteMailboxes` run only in Node, so they are
imported on their own, from `@estoc/mailbox-service/sqlite`. Each is given
the path of a file, which can be the one that a `SqliteBackend` keeps the
store in, so that one file holds all that a service keeps. Each `add`,
`open`, `put` and `drop` is one transaction, on disk by the time it
resolves. They share none with the store, which the service writes an
acknowledgement to before it keeps the account or the mailbox: a service
that stops in between has not answered yet, and the acceptance or the
request posted again opens the account, or a mailbox with other ids.

```ts
import { SqliteAccounts, SqliteMailboxes } from "@estoc/mailbox-service/sqlite";
import { SqliteBackend } from "@estoc/store/sqlite";

const store = new Store(json, new SqliteBackend("service.db"));
const accounts = new SqliteAccounts("service.db");
const mailboxes = new SqliteMailboxes("service.db");
```

`fetch` takes a `Request` and gives a `Response`, as a fetch handler does.
It answers `GET /` and `POST /<id>`, 404 at an id it did not give out and
at any other path, and 410 at the id of an offer that only an earlier
Service lists. No request carries credentials, so it answers any origin,
and it answers the CORS preflight that a browser sends before it posts a
zip or a ciphertext to another origin. It reads a body up to a limit:

- a request, up to 64 KiB;
- a pickup request, up to 128 bytes more for each of the 100 messages that
  an answer holds at most, so that it lists the links of all that the
  receiver is done with of the answer before;
- a ciphertext, up to the size that the offer of its mailbox names.

Bundles travel both ways packed, as `packBundle` of `@estoc/bundle` packs
them, and are read with `unpackBundle`, so a small body cannot unzip to
much more than arrived.

A service opens no account for its own identifier: a signature of its own
over its offer accepts nothing.

## Running with Node

`src/main.ts` runs a service in Node, with its private store in one SQLite
file and all else it keeps in another.
Node runs the TypeScript sources as they are, so a checkout of the
repository with its dependencies installed is all it takes:

```sh
git clone https://github.com/estoc-dev/suite.git && cd suite
pnpm install --frozen-lockfile
node packages/mailbox-service/src/main.ts key /var/lib/mailbox/private.db
```

`main.ts key <path>` makes a private store at `<path>`, a SQLite file that
its owner alone reads, holding a new Ed25519 Secret Key of
`@estoc/identity` for the service's identity, and prints the link of its
key. It refuses to write over a file that is there. The service is named by
the identifier of that identity, so a lost key is a lost service: keep a copy of
the file offline, and take a new one whenever it changes. Only `main.ts key`
writes it for now. It is apart from the database so that each is backed up
on its own: the private store when it changes, the database often.

`main.ts` takes its settings from the environment:

| Variable | Setting |
|---|---|
| `MAILBOX_ORIGIN` | the origin the service is reached at, such as `https://mail.example` |
| `MAILBOX_PRIVATE_STORE` | the path of the private store that `main.ts key` makes |
| `MAILBOX_DATABASE` | the path of the SQLite file that holds the store, the accounts and the mailboxes, made when it is missing |
| `MAILBOX_PORT` | the port it listens at |
| `MAILBOX_HOST` | the address it listens at; 127.0.0.1 unless set |
| `MAILBOX_RETENTION` | the retention that the offer of mailboxes names, in milliseconds; 30 days unless set |
| `MAILBOX_QUOTA` | its quota, in bytes; 64 MiB unless set |
| `MAILBOX_SIZE` | its size, in bytes; 1 MiB unless set |

It signs with the one Secret Key in its private store. Without the private
store, or with no Secret Key or more than one in it, it refuses to start,
since a new key would be another service. Once it serves, it writes a line
with its origin, where it listens and the link of its root. It speaks plain
HTTP, for a proxy in front of it that holds the TLS certificate. It writes a line
for each request, with its method, its status and how long it took. On
SIGTERM it takes no more requests, answers those it took, and closes the
files.

A body comes in as the service reads it, a chunk at a time. Once a body goes
past the service's limit for it, the service reads no more chunks of it and
the rest is dropped, so a large body is not held in memory.

Under systemd, with Caddy in front:

```ini
# /etc/systemd/system/mailbox.service
[Unit]
Description=Mailbox service
After=network.target

[Service]
User=mailbox
WorkingDirectory=/srv/suite
ExecStart=/usr/bin/node packages/mailbox-service/src/main.ts
Environment=MAILBOX_ORIGIN=https://mail.example
Environment=MAILBOX_PRIVATE_STORE=/var/lib/mailbox/private.db
Environment=MAILBOX_DATABASE=/var/lib/mailbox/service.db
Environment=MAILBOX_PORT=8080
Restart=always

[Install]
WantedBy=multi-user.target
```

```
# /etc/caddy/Caddyfile
mail.example {
	reverse_proxy 127.0.0.1:8080
}
```

The database can be backed up while the service runs, with SQLite's
online backup:

```sh
sqlite3 /var/lib/mailbox/service.db ".backup /var/backups/mailbox.db"
```

`src/smoke.ts` checks a running service:

```sh
node packages/mailbox-service/src/smoke.ts https://mail.example
```

It opens a mailbox there under the account of a test identity, sends it a
message, and picks the message up. The identity and the mailbox's key are
fixed, so each run reaches the same account. While the service offers
mailboxes on the same terms, each run reaches the same mailbox too. A change
to `MAILBOX_RETENTION`, `MAILBOX_QUOTA` or `MAILBOX_SIZE` makes another offer,
under which the next run opens another mailbox. Anyone who reads `smoke.ts`
can sign as that identity, which is all right for an account that only tests
a service.

## Running in Docker

`Dockerfile` builds an image of the service, from the root of the
repository:

```sh
docker build -f packages/mailbox-service/Dockerfile -t mailbox-service .
```

The image runs `main.ts` as the `node` user. It listens at port 8080 of the
container, for a proxy on the same network, and keeps its private store
and its database in `/data`. The other settings come from the environment
as above. Arguments go to `main.ts`, so the private store is made with:

```sh
docker run --rm -v mailbox:/data mailbox-service key /data/private.db
```

With Docker Compose, from a folder that holds a checkout of the repository
at `suite`:

```yaml
services:
  mailbox:
    build:
      context: suite
      dockerfile: packages/mailbox-service/Dockerfile
    restart: unless-stopped
    environment:
      MAILBOX_ORIGIN: https://mail.example
    volumes:
      - data:/data

volumes:
  data:
```

`docker compose run --rm mailbox key /data/private.db` makes the private
store in that volume, and `docker compose up -d --build` serves the
checkout as it is after a pull.
