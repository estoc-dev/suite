import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** The HTTP server that `serve` runs. */
export interface HttpServer {
  /** Where it is reached, `http://<address>:<port>`. */
  readonly origin: string;
  /** Stops taking connections, and resolves once the requests it took are answered. */
  close(): Promise<void>;
}

/**
 * Serves `handle` over HTTP at `port` of `host`, or at a free port when
 * `port` is 0, for a proxy in front of it to reach.
 *
 * - A request's body comes in as the handler reads it, so a handler that
 *   stops reading at a limit holds none of the rest of a large body.
 * - When `handle` throws, the request is answered 500.
 */
export async function serve(
  handle: (request: Request) => Promise<Response>,
  port: number,
  host = "127.0.0.1",
): Promise<HttpServer> {
  const server = createServer(async (incoming, outgoing) => {
    let response: Response;
    try {
      response = await handle(requestOf(incoming, origin));
    } catch (error) {
      console.error(error);
      response = new Response(null, { status: 500 });
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) outgoing.end();
    // A client that went away takes no answer.
    else await pipeline(Readable.from(response.body), outgoing).catch(() => {});
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  return { origin, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function requestOf(incoming: IncomingMessage, origin: string): Request {
  const method = incoming.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? null : bodyOf(incoming);
  return new Request(new URL(incoming.url ?? "/", origin), { method, body, duplex: "half" } as RequestInit);
}

/**
 * The body of `incoming`, read as the stream is.
 *
 * - Nothing is read until the stream is, so that Node reads and drops a body
 *   that no one reads.
 * - Once the stream is canceled, the rest of the body is read and dropped
 *   too. `Readable.toWeb` closes the connection then, which a client can find
 *   closed under its next request.
 */
function bodyOf(incoming: IncomingMessage): ReadableStream<Uint8Array> {
  const chunks = incoming.iterator({ destroyOnReturn: false });
  return new ReadableStream(
    {
      async pull(controller) {
        const { done, value } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel() {
        await chunks.return?.();
        incoming.resume();
      },
    },
    { highWaterMark: 0 },
  );
}
