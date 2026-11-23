import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { socketChannel } from "./channel.ts";
import type { Runtime } from "./runtime.ts";

const mediaTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface ExplorerServer {
  readonly origin: string;
  close(): Promise<void>;
}

/**
 * Gives the files of the folder `pages` over HTTP, and a channel to `runtime` over each WebSocket
 * a page of that origin opens.
 *
 * - It listens on the loopback address alone. Another user of the same machine reaches it there,
 *   and is given the store like any page.
 * - A browser lets a page of any site open a WebSocket to this port, and says in `Origin` which
 *   site the page is of, which the page cannot set. A page that reached this port under another
 *   name, as one whose name was made to resolve here, is of that name's origin and is refused too.
 * - The files hold nothing of the store, so they go to whoever asks.
 */
export async function serve(runtime: Runtime, pages: string, port: number): Promise<ExplorerServer> {
  const folder = resolve(pages);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const { pathname } = new URL(incoming.url ?? "/", origin);
      const path = resolve(folder, `.${decodeURIComponent(pathname)}`);
      const file = pathname.endsWith("/") ? join(path, "index.html") : path;
      // The path names a file of the folder once what it encodes is decoded, as `..%2f` shows.
      if (!file.startsWith(folder + sep)) throw new Error(`${file} is outside ${folder}`);
      const body = await readFile(file);
      outgoing.writeHead(200, { "content-type": mediaTypes[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      outgoing.writeHead(404).end();
    }
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.headers.origin !== origin) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => runtime.serve(socketChannel(webSocket)));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close() {
      for (const webSocket of sockets.clients) webSocket.terminate();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
