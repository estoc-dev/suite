import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeObject, encodeSchema, json } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { hex } from "@scure/base";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadHttpTransport } from "../src/http.ts";
import { MailboxKey, mailboxFrom } from "../src/index.ts";

// The receiving side is a server of the test's own, as a receiver would run
// one: what is posted to it is what goes to MailboxKey.open.

interface Request {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly type: string | undefined;
  readonly body: Uint8Array;
}

const answers: Readonly<Record<string, number>> = { "/inbox": 202, "/full": 503, "/moved": 307 };
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
  const status = answers[path ?? ""] ?? 404;
  response.writeHead(status, status === 307 ? { location: "/inbox" } : {}).end();
});
const port = await listen(server);
afterAll(() => close(server));
beforeEach(() => void requests.splice(0));

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
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
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { text: { type: "string" } },
  },
  defaultValidator,
);
const hello = encodeObject(note, { text: "hello, Bob" });
const mailboxAt = (url: string) =>
  mailboxFrom(encodeObject(http.schema, { key, url }).bytes, options);
const take = () => requests.splice(0);

describe("an HTTP mailbox", () => {
  it("takes a message to its url in a POST, sealed so that its key opens it", async () => {
    await (await mailboxAt(`http://127.0.0.1:${port}/inbox`)).send(hello, []);
    const [request, ...more] = take();
    expect(more).toEqual([]);
    expect(request).toMatchObject({
      method: "POST",
      path: "/inbox",
      type: "application/octet-stream",
    });
    expect((await bob.open(request!.body)).root).toEqual(hello.bytes);
  });

  it("rejects a send that the server answers with other than 2xx", async () => {
    const mailbox = await mailboxAt(`http://127.0.0.1:${port}/full`);
    await expect(mailbox.send(hello, [])).rejects.toThrow(/answered 503/);
  });

  it("rejects a send that the server redirects, and the message goes no further", async () => {
    const mailbox = await mailboxAt(`http://127.0.0.1:${port}/moved`);
    await expect(mailbox.send(hello, [])).rejects.toThrow();
    expect(take().map(({ path }) => path)).toEqual(["/moved"]);
  });

  it("rejects a send when nothing listens at its url", async () => {
    const gone = createServer();
    const closed = await listen(gone);
    await close(gone);
    await expect(
      (await mailboxAt(`http://127.0.0.1:${closed}/inbox`)).send(hello, []),
    ).rejects.toThrow();
  });
});

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
    [
      "to another host, with this machine's address as the user",
      "http://127.0.0.1@mail.example/inbox",
    ],
    ["not a URI", "https://mail example/alice"],
  ])("is refused when it is %s", async (_, url) => {
    await expect(mailboxFrom(written(url), options)).rejects.toThrow(/#\/url/);
  });
});
