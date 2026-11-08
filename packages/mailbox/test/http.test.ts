import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeObject, encodeSchema, json, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { MemoryBackend, PrivateStore, Store } from "@estoc/store";
import { hex } from "@scure/base";
import { afterAll, assert, beforeEach, describe, expect, it } from "vitest";
import { loadHttpTransport } from "../src/http.ts";
import { loadPost, MailboxKey, mailboxFrom, UndeliveredMessage } from "../src/index.ts";

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
  const late = path === "/late-once" && requests.filter((each) => each.path === path).length === 1;
  const status = late ? 408 : (answers[path ?? ""] ?? Number(/^\/answer\/([0-9]{3})$/.exec(path ?? "")?.[1] ?? 404));
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

const http = await loadHttpTransport(defaultValidator);
const options = { transports: [http] };
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));
const key = hex.encode(bob.publicKey);
const note = await encodeSchema(
  { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { text: { type: "string" } } },
  defaultValidator,
);
const hello = encodeObject(note, { text: "hello, Bob" });
const mailboxAt = (url: string) => mailboxFrom(encodeObject(http.schema, { key, url }).bytes, options);
const take = () => requests.splice(0);

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
    await (await mailboxAt(`http://127.0.0.1:${port}/inbox`)).send(hello, []);
    const [request, ...more] = take();
    expect(more).toEqual([]);
    assert.exists(request);
    expect(request).toMatchObject({ method: "POST", path: "/inbox", type: "application/octet-stream" });
    expect((await bob.open(request.body)).root).toEqual(hello.bytes);
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
    const mailbox = await mailboxAt(`http://127.0.0.1:${port}/answer/${status}`);
    expect(await rejectedAs(mailbox.send(hello, []))).toBe(kind);
  });

  it("rejects a send that the server redirects as one to send later, and the message goes no further", async () => {
    const mailbox = await mailboxAt(`http://127.0.0.1:${port}/moved`);
    expect(await rejectedAs(mailbox.send(hello, []))).toBe("later");
    expect(take().map(({ path }) => path)).toEqual(["/moved"]);
  });

  it("rejects a send as one to send later when nothing listens at its url", async () => {
    const gone = createServer();
    const closed = await listen(gone);
    await close(gone);
    expect(await rejectedAs((await mailboxAt(`http://127.0.0.1:${closed}/inbox`)).send(hello, []))).toBe("later");
  });
});

describe("an HTTP outbox", () => {
  it("records nothing of a send that the server timed out on, and records the same root once sent again", async () => {
    const store = new Store(json, new MemoryBackend());
    const privateStore = new PrivateStore(store, new MemoryBackend());
    const post = await loadPost(store, privateStore, { ...options, validator: defaultValidator });
    const mailbox = encodeObject(http.schema, { key, url: `http://127.0.0.1:${port}/late-once` });
    await store.write({ records: [mailbox, hello], blobs: [...http.schema.blobs, note.bytes] });
    const outbox = await post.outbox(mailbox.link);
    const before = await listed(store);

    expect(await rejectedAs(outbox.send(hello.link))).toBe("later");
    expect(await listed(store)).toEqual(before);

    const sent = await outbox.send(hello.link);
    expect(new Set(await listed(store))).toEqual(new Set([...before, sent.link]));
    const requested = take();
    expect(requested.map(({ path }) => path)).toEqual(["/late-once", "/late-once"]);
    const through = requested.at(-1);
    assert.exists(through);
    expect((await bob.open(through.body)).link).toBe(hello.link);
  });
});

async function listed(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.records()) links.push(link);
  return links;
}

describe("an HTTP mailbox's url", () => {
  it.each([
    "https://mail.example/alice",
    "http://localhost:8080/inbox",
    "http://127.0.0.1",
    "http://[::1]:8080?to=bob",
  ])("may be %s", async (url) => {
    await expect(mailboxAt(url)).resolves.toBeDefined();
  });

  // Written elsewhere, since this package does not write a mailbox it would refuse.
  const written = (url: string) => json.encode(json.object({ key, url }, http.schema.link));

  it.each([
    ["plain http to another machine", "http://mail.example/alice"],
    ["of another scheme", "ftp://mail.example/alice"],
    ["to a host whose name only starts as this machine's", "http://localhost.mail.example/inbox"],
    ["to another host, with this machine's address as the user", "http://127.0.0.1@mail.example/inbox"],
    ["not a URI", "https://mail example/alice"],
  ])("is refused when it is %s", async (_, url) => {
    await expect(mailboxFrom(written(url), options)).rejects.toThrow(/#\/url/);
  });
});
