import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeObject } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { MemoryBackend, Store } from "@estoc/store";
import { afterAll, afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { httpTransport as http } from "../src/http.ts";
import { MailboxKey, mailboxAt, Post, UndeliveredMessage } from "../src/index.ts";
import { listedIn } from "./listed.ts";
import { mailboxBundle } from "./mailbox-bundle.ts";

// The receiving side is a server of the test's own, as a receiver would run
// one: what is posted to it is what goes to MailboxKey.open. A POST to
// /answer/<status> is answered with that status, and one to /late-once 408
// the first time in a test, as when the body came too slowly, and 202 after.

interface Request {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly type: string | undefined;
  readonly body: Uint8Array;
}

const answers: Readonly<Record<string, number>> = { "/inbox": 202, "/moved": 307, "/late-once": 202 };
const requests: Request[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const path = request.url;
  requests.push({
    method: request.method,
    path,
    type: request.headers["content-type"],
    body: new Uint8Array(Buffer.concat(chunks)),
  });
  const isTimedOut = path === "/late-once" && requests.filter((each) => each.path === path).length === 1;
  const status = isTimedOut
    ? 408
    : (answers[path ?? ""] ?? Number(/^\/answer\/([0-9]{3})$/.exec(path ?? "")?.[1] ?? 404));
  response.writeHead(status, status === 307 ? { location: "/inbox" } : {}).end();
});
const port = await listen(server);
afterAll(() => close(server));
beforeEach(() => void requests.splice(0));

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

const options = { transports: [http] };
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));
const key = bob.publicKey;
const note = schema("Note", { text: string() });
const hello = encodeObject(note, { text: "hello, Bob" });
const mailboxBundleAt = (url: string) => mailboxBundle(key, encodeObject(http.schema, { url }));
const mailboxTo = (url: string) => {
  const mailbox = mailboxBundleAt(url);
  return mailboxAt(mailbox.link, mailbox, options);
};
const take = () => requests.splice(0);
const mockFetch = () => vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
const postedBy = (fetch: ReturnType<typeof mockFetch>) =>
  fetch.mock.calls.map((call) => new globalThis.Request(...call));
afterEach(() => vi.restoreAllMocks());

async function rejectedAs(sending: Promise<unknown>): Promise<UndeliveredMessage["kind"]> {
  const error = await sending.then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.instanceOf(error, UndeliveredMessage);
  return error.kind;
}

describe("an HTTP mailbox", () => {
  it("takes a message to its url in a POST, sealed so that its key opens it", async () => {
    await (await mailboxTo(`http://127.0.0.1:${port}/inbox`)).send(hello.link, [hello.bytes]);
    const [request, ...more] = take();
    expect(more).toEqual([]);
    assert.exists(request);
    expect(request).toMatchObject({ method: "POST", path: "/inbox", type: "application/octet-stream" });
    expect((await bob.open(request.body)).root).toEqual(hello.bytes);
  });

  it("sends each message with no referrer and no credentials", async () => {
    const fetch = mockFetch();
    const mailbox = await mailboxTo("https://mail.example/alice");
    await mailbox.send(hello.link, [hello.bytes]);
    await mailbox.send(hello.link, [hello.bytes]);
    const sent = { referrerPolicy: "no-referrer", credentials: "omit" };
    expect(postedBy(fetch)).toMatchObject([sent, sent]);
  });

  it.each<[number, UndeliveredMessage["kind"]]>([
    [404, "gone"],
    [410, "gone"],
    [408, "later"],
    [429, "later"],
    [500, "later"],
    [503, "later"],
    [400, "refused"],
    [413, "refused"],
  ])("rejects a send that the server answers %i as undelivered, %s", async (status, kind) => {
    const mailbox = await mailboxTo(`http://127.0.0.1:${port}/answer/${status}`);
    expect(await rejectedAs(mailbox.send(hello.link, [hello.bytes]))).toBe(kind);
  });

  it("rejects a send that the server redirects as one to send later, and the message goes no further", async () => {
    const mailbox = await mailboxTo(`http://127.0.0.1:${port}/moved`);
    expect(await rejectedAs(mailbox.send(hello.link, [hello.bytes]))).toBe("later");
    expect(take().map(({ path }) => path)).toEqual(["/moved"]);
  });

  it("rejects a send as one to send later when nothing listens at its url", async () => {
    const gone = createServer();
    const closedPort = await listen(gone);
    await close(gone);
    expect(
      await rejectedAs((await mailboxTo(`http://127.0.0.1:${closedPort}/inbox`)).send(hello.link, [hello.bytes])),
    ).toBe("later");
  });
});

describe("an HTTP outbox", () => {
  it("marks nothing of a send that the server timed out on, and marks the same root once sent again", async () => {
    const backend = new MemoryBackend();
    const store = new Store(backend);
    const post = new Post(store, options);
    const mailbox = mailboxBundleAt(`http://127.0.0.1:${port}/late-once`);
    await store.write({ roots: [mailbox.link, hello.link], blobs: [...mailbox.blobs(), hello.bytes, ...note.blobs] });
    const outbox = await post.outbox(mailbox.link);
    expect(await rejectedAs(outbox.send(hello.link))).toBe("later");
    expect(await listedIn(store)).toEqual([]);

    const delivery = await outbox.send(hello.link);
    expect(await listedIn(store)).toEqual([delivery.link]);
    const sentRequests = take();
    expect(sentRequests.map(({ path }) => path)).toEqual(["/late-once", "/late-once"]);
    const through = sentRequests.at(-1);
    assert.exists(through);
    expect((await bob.open(through.body)).link).toBe(hello.link);
  });
});

describe("an HTTP transport's url", () => {
  it.each([
    "https://mail.example/alice",
    "http://localhost:8080/inbox",
    "http://127.0.0.1",
    "http://[::1]:8080?to=bob",
  ])("may be %s", async (url) => {
    const fetch = mockFetch();
    await (await mailboxTo(url)).send(hello.link, [hello.bytes]);
    expect(postedBy(fetch).map(({ url }) => url)).toEqual([new URL(url).href]);
  });

  it.each([
    ["plain http to another machine", "http://mail.example/alice"],
    ["of another scheme", "ftp://mail.example/alice"],
    ["to a host whose name only starts as this machine's", "http://localhost.mail.example/inbox"],
    ["to another host, with this machine's address as the user", "http://127.0.0.1@mail.example/inbox"],
    ["one with a user name, which fetch refuses", "https://bob@mail.example/inbox"],
    ["not a URL", "https://mail example/alice"],
  ])("turns the mailbox back as one that is gone when it is %s", async (_, url) => {
    expect(await rejectedAs(mailboxTo(url))).toBe("gone");
  });
});
