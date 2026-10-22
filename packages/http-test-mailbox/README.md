# @estoc/http-test-mailbox

A server of HTTP mailboxes for trying them on one machine, and commands to
receive and send with it. The server keeps each message as the sealed
bytes that arrived until the receiver takes it: it holds no key and opens
nothing. It listens on 127.0.0.1 alone and asks no one who they are, so it
is for testing, not for receiving from the network.

```bash
node packages/http-test-mailbox/src/cli.ts serve queues
node packages/http-test-mailbox/src/cli.ts init bob
node packages/http-test-mailbox/src/cli.ts send bob/mailbox.json <bundle>
node packages/http-test-mailbox/src/cli.ts receive bob
```

Node runs the TypeScript as it is, from Node 26 on, with nothing to build.

## The server

`serve <dir> [--port <port>]` listens on `http://127.0.0.1:<port>`, port
8080 unless given, or any free port for 0, and prints its url. A queue is
one segment of path under it: 1 to 64 letters, digits, `-` and `_`. A queue
need not be made first. Each one is a folder under `<dir>`, holding each
message as a file named by the lowercase hex SHA-256 of its sealed bytes,
its id.

```
POST    /<queue>        keeps the body as a message, and answers 202
GET     /<queue>        lists the ids of the messages waiting, as a JSON array
GET     /<queue>/<id>   gives the sealed bytes of a message
DELETE  /<queue>/<id>   deletes a message, once the receiver has kept it
```

A message has 16 MiB at most. A longer body is answered with 413 and not
kept, whether it gives its length or comes in chunks. The same bytes posted
twice are kept once. A page in a browser can post to a queue: the server
answers its preflight, and lets it read the answer, as `@estoc/mailbox/http`
asks of a server that browsers send to.

Listing, fetching and deleting ask nothing of whoever does them, so
anything that reaches the port can do all three. A server for the network
would take messages from anyone and give them only to whoever shows that
they hold the mailbox's key; this one does not.

## Receiving

`init <dir> [--server <url>]` makes a mailbox at a new queue, with a random
name, on the server at `<url>`, `http://127.0.0.1:8080` unless given. It
keeps 32 random secret bytes in `<dir>/secret`, which only its owner can
read, and `MailboxKey` makes the key from them. It writes the mailbox to
`<dir>/mailbox.json` and prints it. It refuses a folder that already holds
a secret.

`receive <dir>` takes the messages waiting at the mailbox. It opens each
with the key and keeps it as a bundle folder, `<dir>/inbox/<hex>`, named by
the hex of the root's link. Only then is the message deleted from the
server, so one that could not be kept waits for the next `receive`. A
message that arrives again adds what it carries to the same folder. A
message that does not open, with the key or as a bundle, will not open
later either, so it is deleted and reported.

## Sending

`send <mailbox> <bundle>` sends the bundle at `<bundle>`, a folder or a zip
of one, to the mailbox in the file `<mailbox>`, with the transport of
`@estoc/mailbox/http`. The mailbox can be any HTTP mailbox, not only one on
this server.

## In code

The commands are made of what this package exports: `TestMailboxServer`,
`TestInbox`, which is bound to a mailbox and the key that opens what is
sent there, and `readBundleAt` and `writeBundleTo` for bundles on a disk.

```ts
import { MailboxKey } from "@estoc/mailbox";
import { loadHttpTransport } from "@estoc/mailbox/http";
import { defaultValidator } from "@estoc/object/default-validator";
import { TestInbox, TestMailboxServer, writeBundleTo } from "@estoc/http-test-mailbox";

const server = await TestMailboxServer.listen({ dir: "queues", port: 0 });
// server.url is http://127.0.0.1:<port>, and a mailbox's url names a queue under it.

const http = await loadHttpTransport(defaultValidator);
const key = await MailboxKey.fromSecretKey(secretKey);
const inbox = TestInbox.from(mailbox.bytes, key, http);
await inbox.take((bundle) => writeBundleTo(`inbox/${bundle.link.slice("sha256:".length)}`, bundle));
```

`take` hands each bundle to the function given and deletes the message
once it resolves. It gives back what it took: each message's id, with the
bundle or with why it did not open.
