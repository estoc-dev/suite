import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TestMailboxServer } from "../src/index.ts";

const dir = await mkdtemp(join(tmpdir(), "http-test-mailbox-"));
const server = await TestMailboxServer.listen({ dir, maxBytes: 64 });
afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true });
});

let queues = 0;
const newQueue = () => `${server.url}/queue-${++queues}`;
const idOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const post = (url: string, body: Uint8Array) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body });
const list = async (queue: string) => (await fetch(queue)).json();

describe("a test mailbox server", () => {
  it("listens on 127.0.0.1", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);
  });

  it("keeps what is posted to a queue, as it arrived, until it is deleted", async () => {
    const queue = newQueue();
    const sealed = crypto.getRandomValues(new Uint8Array(32));
    expect((await post(queue, sealed)).status).toBe(202);
    expect(await list(queue)).toEqual([idOf(sealed)]);
    const fetched = await fetch(`${queue}/${idOf(sealed)}`);
    expect(fetched.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(sealed);
    expect((await fetch(`${queue}/${idOf(sealed)}`, { method: "DELETE" })).status).toBe(204);
    expect(await list(queue)).toEqual([]);
    expect((await fetch(`${queue}/${idOf(sealed)}`)).status).toBe(404);
  });

  it("keeps the same bytes posted twice once, and each queue apart", async () => {
    const [one, other] = [newQueue(), newQueue()];
    const sealed = new Uint8Array(32).fill(1);
    await post(one, sealed);
    await post(one, sealed);
    await post(other, new Uint8Array(32).fill(2));
    expect(await list(one)).toEqual([idOf(sealed)]);
    expect(await list(other)).toEqual([idOf(new Uint8Array(32).fill(2))]);
  });

  it("lists a queue that nothing was posted to as empty", async () => {
    expect(await list(newQueue())).toEqual([]);
  });

  it("answers 413 to a message over its limit, and keeps nothing", async () => {
    const queue = newQueue();
    expect((await post(queue, new Uint8Array(65))).status).toBe(413);
    expect(await list(queue)).toEqual([]);
    expect((await post(queue, new Uint8Array(64))).status).toBe(202);
  });

  it("answers 413 to a message over its limit that comes in chunks, with no length given", async () => {
    const queue = newQueue();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const chunked = request(queue, { method: "POST" }, (response) => resolve(response.resume().statusCode));
      chunked.on("error", reject);
      for (let n = 0; n < 4; n++) chunked.write(new Uint8Array(32));
      chunked.end();
    });
    expect(status).toBe(413);
    expect(await list(queue)).toEqual([]);
  });

  it("lets a page in a browser post to a queue and read the answer", async () => {
    const queue = newQueue();
    const preflight = await fetch(queue, {
      method: "OPTIONS",
      headers: { origin: "https://example.org", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toBe("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type");
    expect((await post(queue, new Uint8Array(1))).headers.get("access-control-allow-origin")).toBe("*");
  });

  it("keeps a message in its queue's folder, by the hex of its SHA-256, and nothing else there", async () => {
    const queue = newQueue();
    const sealed = new Uint8Array(32).fill(3);
    await post(queue, sealed);
    expect(await readdir(join(dir, queue.slice(server.url.length + 1)))).toEqual([idOf(sealed)]);
  });

  it.each([
    ["/", "GET"],
    ["/has%20space", "POST"],
    [`/${"q".repeat(65)}`, "POST"],
    ["/queue/not-an-id", "GET"],
    [`/queue/${"A".repeat(64)}`, "GET"],
    [`/queue/${"a".repeat(64)}/more`, "GET"],
  ])("answers 404 at %s, which is neither a queue nor a message in one", async (path, method) => {
    expect((await fetch(`${server.url}${path}`, { method })).status).toBe(404);
  });

  it.each([
    ["PUT", "a queue", "", "POST, GET, OPTIONS"],
    ["DELETE", "a queue", "", "POST, GET, OPTIONS"],
    ["POST", "a message", `/${"a".repeat(64)}`, "GET, DELETE"],
  ])("answers 405 to %s at %s", async (method, _, rest, allow) => {
    const response = await fetch(`${newQueue()}${rest}`, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(allow);
  });
});
