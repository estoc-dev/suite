import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

const PATH = /^\/(?<queue>[A-Za-z0-9_-]{1,64})(?:\/(?<id>[0-9a-f]{64}))?$/;
const ID = /^[0-9a-f]{64}$/;
const MAX_BYTES = 16 * 2 ** 20;

// A page in a browser sends to a mailbox at another origin, and asks first
// before it posts application/octet-stream.
const SEND_CORS = { "access-control-allow-origin": "*" };
const PREFLIGHT = { ...SEND_CORS, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" };

export interface ServerOptions {
  /** The folder that keeps each queue as a folder of the messages waiting in it. */
  readonly dir: string;
  /** 0, or unless given, for any free port. */
  readonly port?: number;
  /** The most bytes a message may have; 16 MiB unless given. */
  readonly maxBytes?: number;
}

/**
 * A server of HTTP mailboxes on 127.0.0.1, for trying them on one machine.
 * It keeps each message as the sealed bytes that arrived, until the
 * receiver deletes it, and holds no key. Reading and deleting ask no one
 * who they are.
 */
export class TestMailboxServer {
  /** `http://127.0.0.1:<port>`, under which each queue is one segment of path. */
  readonly url: string;
  readonly #server: Server;

  private constructor(server: Server, url: string) {
    this.#server = server;
    this.url = url;
  }

  static async listen({ dir, port = 0, maxBytes = MAX_BYTES }: ServerOptions): Promise<TestMailboxServer> {
    const server = createServer((request, response) => {
      serve(request, response, dir, maxBytes).catch(() => {
        if (response.headersSent) response.destroy();
        else response.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    return new TestMailboxServer(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }

  close(): Promise<void> {
    this.#server.closeAllConnections();
    return new Promise((resolve, reject) => this.#server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function serve(request: IncomingMessage, response: ServerResponse, dir: string, maxBytes: number): Promise<void> {
  const answer = (status: number, headers: OutgoingHttpHeaders = {}, body?: Uint8Array | string) =>
    void response.writeHead(status, headers).end(body);
  const match = PATH.exec(new URL(request.url ?? "", "http://127.0.0.1").pathname);
  if (match === null) return answer(404);
  const { queue, id } = match.groups as { readonly queue: string; readonly id?: string };
  const folder = join(dir, queue);
  if (id === undefined) {
    switch (request.method) {
      case "POST": {
        const sealed = await readBody(request, maxBytes);
        if (sealed === undefined) return answer(413, { ...SEND_CORS, connection: "close" });
        await keep(folder, sealed);
        return answer(202, SEND_CORS);
      }
      case "OPTIONS":
        return answer(204, PREFLIGHT);
      case "GET":
        return answer(200, { "content-type": "application/json" }, JSON.stringify(await waiting(folder)));
      default:
        return answer(405, { allow: "POST, GET, OPTIONS" });
    }
  }
  const file = join(folder, id);
  switch (request.method) {
    case "GET": {
      const sealed = await ifThere(readFile(file));
      if (sealed === undefined) return answer(404);
      return answer(200, { "content-type": "application/octet-stream" }, sealed);
    }
    case "DELETE":
      await rm(file, { force: true });
      return answer(204);
    default:
      return answer(405, { allow: "GET, DELETE" });
  }
}

// Gives undefined for a body over `maxBytes`, and stops reading it.
function readBody(request: IncomingMessage, maxBytes: number): Promise<Uint8Array | undefined> {
  if (Number(request.headers["content-length"]) > maxBytes) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    request.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length <= maxBytes) return void chunks.push(chunk);
      request.pause();
      resolve(undefined);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

// Written under another name and renamed, so that a message waits whole or
// not at all. The same bytes have the same name, and are kept once.
async function keep(folder: string, sealed: Uint8Array): Promise<void> {
  await mkdir(folder, { recursive: true });
  const id = createHash("sha256").update(sealed).digest("hex");
  const part = join(folder, `${id}.${randomUUID()}.part`);
  await writeFile(part, sealed);
  await rename(part, join(folder, id));
}

async function waiting(folder: string): Promise<string[]> {
  return ((await ifThere(readdir(folder))) ?? []).filter((name) => ID.test(name));
}

async function ifThere<T>(reading: Promise<T>): Promise<T | undefined> {
  try {
    return await reading;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
