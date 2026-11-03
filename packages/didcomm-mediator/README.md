# @estoc/didcomm-mediator

**Status: planned.** Nothing here is built yet. This file is the plan, and
the decisions behind it; each phase rewrites its part into a description
of what was built.

A DIDComm v2 mediator built as a client of a mailbox service of
`@estoc/mailbox-service`. DIDComm wallets ask it for mediation, have
messages forwarded through it and pick them up, all in DIDComm; it
translates each of those into what the mailbox service already
understands. The service is not changed, and does not know that DIDComm
exists.

- The mediator holds an Estoc identity, has one account at the service,
  and opens one mailbox there for each recipient DID.
- What DIDComm adds is a layer over that. `next` is a table from a
  recipient DID to a send url, and forwarding is `Transport.deliver` of
  `@estoc/mailbox`, as any sender delivers.
- The mediator's own state is objects, which it writes to a store of
  `@estoc/store` and reads through its indexes.
- The mediator never opens what it forwards: it holds no recipient's
  secret, and passes on opaque bytes as the service does.
- What does not translate is listed under "Deviations", and is not forced
  into the core.

## Layers

```
DIDComm wallet or sender
   │  JWE over HTTPS
   ▼
① envelopes     JWE anoncrypt and authcrypt, JWS, did:peer:2/4 and did:key   knows nothing of Estoc
② translation   Routing 2.0, Coordinate Mediation 3.0, Pickup 3.0,           knows both
                Discover Features 2.0 → requests to the service
   │  signed bundles over HTTPS
   ▼
③ @estoc/mailbox-service, unchanged
```

## Translation

### Routing 2.0: `forward`

The spec's mediator takes the service endpoint that the recipient set up
beforehand, found by `next`, and sends the payload there. Here that
endpoint is the send url of the recipient's mailbox at the service.

| DIDComm | Estoc |
|---|---|
| The outer JWE, anoncrypted to the mediator's DID | opened with the mediator's X25519 key |
| `next` | a DID, or a key at the last hop: the fragment is dropped, and the Route index gives the HTTP mailbox `{key, url}`; none answers 404 |
| each of `attachments` | `base64` as it is; `json` written as JCS, so that the same message forwarded again has the same link and waits once; `links` refused |
| passing it on | `deliver(mailbox, bytes)` of the HTTP transport; 202 once every attachment is handed on |
| `Undelivered` | `later` answers 503, `gone` 404, `refused` 413; the sender is anonymous, so no problem report can go back |
| `expires_time`, `delay_milli` | ignored, which the spec allows |

### Coordinate Mediation 3.0

| DIDComm | Estoc |
|---|---|
| `mediate-request`, authenticated as the client DID C | by the mediator's policy: a `Mediation` record and `mediate-grant {routing_did: [the mediator's DID]}`, or `mediate-deny` |
| `recipient-update`, `add` R | resolve R, take its X25519 keyAgreement key, `service.mailbox.open(actor, key)`, write the mailbox to the store and a `Route` record |
| `remove` R | an `Unroute` record; a forward to R then answers 404. The mailbox at the service is not revoked: it retires once nobody picks up there, and what waits lapses with the retention |
| `result` | `success`; `no_change` when the route already is as asked, or the update is not newer (see "Replay"); `client_error` when R does not resolve, has no X25519 keyAgreement key, or is another client's; `server_error` when the service refuses |
| `recipient-query` with `paginate` | `recipient {dids, pagination}`, from C's routes that are not unrouted |

Opening a mailbox again is free of side effects already. A mailbox request
is `{offer, key}` signed by Ed25519, whose signatures are deterministic, so
adding R twice is the same request, and the service answers it with the
same acknowledgement.

### Pickup 3.0

| DIDComm | Estoc |
|---|---|
| `delivery-request {limit, recipient_did?}` | a pickup request with `done: []` at each of C's mailboxes, or at R's alone; a `delivery` of the sealed bytes that wait, at most `limit`, each attachment `{id: <link of the bytes>, data: {base64}}`. With none waiting, a `status` at once, as the spec asks |
| `messages-received {message_id_list}` | the `done` of a pickup request at the mailbox each id came from, answered with a `status`. Which mailbox an id came from is kept in memory, as the state of a running program; ids it does not know after a restart go to every mailbox of C, and the service's `drop` passes over a link that does not wait there |
| `status-request {recipient_did?}` | a pickup request with `done: []`; `message_count` is the number of sealed bytes in the answers |
| `live-delivery-change` | the problem report `e.m.live-mode-not-supported`, as the spec allows over a connection that cannot carry it |

Both sides deliver at least once. A message whose receipt the client does
not acknowledge, or that the mediator handed out before it restarted, is
delivered again, so nothing has to be added to make the two agree.

### Discover Features 2.0

The mediator discloses the protocols above, and the constraint
`max_receive_bytes`: the `size` of the mailbox offer, plus room for the
outer envelope of a forward. A forward over it answers 413, as the spec
allows in place of the problem report `me.res.storage.message_too_big`.

## Transport

HTTPS POST, with the body's media type, `application/didcomm-encrypted+json`
for a JWE. A forward is answered 202 with no body, since DIDComm over
HTTPS is one-way. Coordinate Mediation and Pickup messages carry the
header `return_route: all` of the Return-Route extension, and their answer
is the body of the same response. One without it is refused with 400: the
mediator keeps no queue toward its clients. WebSockets come later.

## Envelopes

- Opens anoncrypt, `ECDH-ES+A256KW`, with `A256CBC-HS512`, `A256GCM` and
  `XC20P`: an anoncrypt sender picks among them, and a forward the
  mediator cannot open would be lost.
- Opens and writes authcrypt, `ECDH-1PU+A256KW` with `A256CBC-HS512`, the
  one content encryption authcrypt allows, and anoncrypt of a signed
  message.
- Verifies JWS by `EdDSA` over Ed25519, `ES256` and `ES256K`, and signs
  by `EdDSA`.
- Publishes an X25519 keyAgreement key alone, so a sender that forwards
  to it and a client that authcrypts to it use X25519.
- Resolves `did:peer:2`, `did:peer:4` and `did:key` with no network.
- Is written over `@noble/curves`, `@noble/hashes` and `@noble/ciphers`.
  `jose` has no ECDH-1PU.

The mediator's own DID is a `did:peer:2` with its X25519 key under `E`
and a `DIDCommMessaging` service under `S`. A client puts it in the `uri`
of its own service, as the spec's "Using a DID as an endpoint" does. The
DID is static, so a mediator that moves hands out a new one, as moving is
handing out a new mailbox.

## Who may do what

- A client is the DID that a message is authcrypted from, or signed by.
  A message that is only anoncrypted is taken as a `forward` and as
  nothing else.
- A recipient DID is one client's, the first to add it. Otherwise
  another client could add R, pick up what waits for it and acknowledge
  it away, though it could open none of it.
- The mediator's account at the service is a full one: every request it
  signs is acknowledged by the service's signature. Between a client and
  the mediator there are only the mediator's records, and the client
  signs nothing that is kept. That is as strong as DIDComm makes it.

## Replay

A request either does no harm when it comes again, or holds what makes it
fresh. A `forward`, `mediate-request`, `delivery-request`,
`messages-received` and `status-request` do no harm. A `recipient-update`
can: removing R, adding it back, and replaying the removal would take the
new route away, and replaying an add after a removal would route to a
mailbox nobody picks up at. So a `recipient-update` has to carry
`created_time`, and an update of R counts only when its `created_time` is
later than that of the last update of R that counted; otherwise it is
answered `no_change`. Both times are the client's clock.

## Records

Written as the mediator's own to its store, unsigned, since no one but
the mediator reads them:

```
Mediation  {"client": <DID>, "at": <milliseconds>}
Route      {"mediation": <link of the Mediation>, "recipient": <DID>, "mailbox": <link of the service's signature over the mailbox acknowledgement>, "requested": <created_time>, "at": <milliseconds>}
Unroute    {"route": <link of the Route>, "requested": <created_time>, "at": <milliseconds>}
```

Indexes of `@estoc/store` find the route of a recipient DID, for a
forward, and the routes of a client, for a query and a pickup.

## The one change to @estoc/mailbox-service

The client's `Pickup` gives `arrivals()` alone, which picks up until
nothing new comes and sends `done` with the next request of the same
iteration. A `delivery-request` and its `messages-received` are two HTTP
requests, so the client also gives one pickup request on its own: send
`done`, get back what waits. Only added; the service is not touched.

## Deviations from DIDComm

- Key agreement: the spec asks for X25519, P-384 and P-256. The mediator
  publishes X25519 alone, and a recipient DID needs an X25519
  keyAgreement key, since a mailbox's `key` is one.
- Live mode is not supported.
- `message_count` is a lower bound once more waits than one answer of
  the service holds, 100 messages or 1 MiB; `status` gives none of its
  optional fields of time.
- Attachments by `links` are refused.
- A `recipient-update` has to carry `created_time`, and Coordinate
  Mediation and Pickup messages `return_route: all`.
- `retention` and `quota` of the mailbox offer are not disclosed; a
  sender learns of the quota by 503.
- The client signs nothing the mediator keeps.

## Phases

| Phase | What | Done when |
|---|---|---|
| 1 Envelopes | did:peer:2/4 and did:key; anoncrypt and authcrypt; JWS | the test vectors of the spec's appendix pass |
| 2 Forward | the mediator's DID and key, in a private store; routes from a fixture | a sender's forward through the mediator to a service with `MemoryMailboxes` is picked up by `Services.pickup` as the inner JWE, which R opens |
| 3 Pickup | the single pickup request; delivery, receipt, status | a DIDComm client picks up, acknowledges, and is not given the messages again |
| 4 Coordinate Mediation | the records and their indexes; the replay rule; Discover Features | from `mediate-request` to receiving, the client speaks DIDComm alone |
| Later | live mode over WebSockets; the other way, an Estoc client using another's mediator as a `Transport`; a DID method for a service's root | |

Each phase is one commit, with its tests and its part of this file
rewritten. Tests run local HTTP servers, as those of
`@estoc/mailbox-service` do, and stub no `fetch`.

## Choices for v1, open to change

1. Envelopes written over `@noble/*` rather than a WebAssembly build of a
   DIDComm library, which may serve as a development dependency to test
   against.
2. The mediator's DID is a `did:peer:2`, so moving changes it, and every
   client's DID with it. A DID method that resolves a service's root to
   its latest Service would follow it instead.
3. A recipient DID with more than one X25519 keyAgreement key has one
   mailbox, under the first. One mailbox for each key, with a forward
   delivered to each, is the other way.
4. `message_count` stays a lower bound. A total in `Waiting` would make
   it exact, at the cost of a change to the service.

## Sources

- DIDComm Messaging v2.1: https://identity.foundation/didcomm-messaging/spec/v2.1/
  (Routing 2.0, envelopes, HTTPS, `max_receive_bytes`, test vectors in
  appendices A to C)
- Coordinate Mediation 3.0: https://didcomm.org/coordinate-mediation/3.0/
- Pickup 3.0: https://didcomm.org/messagepickup/3.0/
- Return-Route and Queue Transport extension:
  https://github.com/decentralized-identity/didcomm-messaging/blob/main/extensions/return_route/main.md
- Peer DID Method: https://identity.foundation/peer-did-method-spec/
