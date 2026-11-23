import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { WebSocket } from "ws";
import { Client, socketChannel } from "../src/index.ts";
import { serve } from "../src/node.ts";
import { Runtime } from "../src/runtime.ts";
import { makeTemporaryFolder, note, storeOfNote } from "./fixtures.ts";

/** A runtime over the store of the note, served with a folder of pages that has a file beside it. */
async function startServer() {
  const folder = await makeTemporaryFolder();
  const pages = join(folder, "pages");
  await mkdir(join(pages, "assets"), { recursive: true });
  await writeFile(join(pages, "index.html"), "<!doctype html>");
  await writeFile(join(pages, "assets", "page.js"), "export {};");
  await writeFile(join(pages, "assets", "font.woff2"), "a font");
  await writeFile(join(folder, "beside.txt"), "beside the pages");
  const server = await serve(new Runtime(await storeOfNote()), pages, 0);
  onTestFinished(() => server.close());
  return server;
}

function openSocket(origin: string, pageOrigin: string | undefined): WebSocket {
  const socket = new WebSocket(origin.replace("http", "ws"), pageOrigin === undefined ? {} : { origin: pageOrigin });
  onTestFinished(() => socket.terminate());
  return socket;
}

describe("serve", () => {
  it.each([
    ["/", "<!doctype html>", "text/html; charset=utf-8"],
    ["/index.html", "<!doctype html>", "text/html; charset=utf-8"],
    ["/assets/page.js", "export {};", "text/javascript; charset=utf-8"],
    ["/assets/font.woff2", "a font", "application/octet-stream"],
  ])("gives %s of its folder", async (path, text, mediaType) => {
    const { origin } = await startServer();
    const response = await fetch(`${origin}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(mediaType);
    expect(await response.text()).toBe(text);
  });

  it.each(["/absent.html", "/assets", "/..%2fbeside.txt", "/assets/..%2f..%2fbeside.txt", "/%"])(
    "answers 404 for %s, which names no file of its folder",
    async (path) => {
      const { origin } = await startServer();
      expect((await fetch(`${origin}${path}`)).status).toBe(404);
    },
  );

  it("gives a channel to its runtime over a WebSocket that a page of its origin opens", async () => {
    const { origin } = await startServer();
    const socket = openSocket(origin, origin);
    await once(socket, "open");
    expect(await new Client(socketChannel(socket)).get(note.link)).toEqual(note.bytes);
  });

  it.each<[string, (origin: string) => string | undefined]>([
    ["a page of another origin", () => "http://example.com"],
    ["a page that reached it under another name", (origin) => origin.replace("127.0.0.1", "localhost")],
    ["what names no origin", () => undefined],
  ])("refuses a WebSocket that %s opens", async (_, pageOriginOf) => {
    const { origin } = await startServer();
    await expect(once(openSocket(origin, pageOriginOf(origin)), "open")).rejects.toThrow(
      "Unexpected server response: 403",
    );
  });

  it("closes the channels that are open when it closes", async () => {
    const server = await startServer();
    const socket = openSocket(server.origin, server.origin);
    await once(socket, "open");
    const client = new Client(socketChannel(socket));
    await Promise.all([once(socket, "close"), server.close()]);
    await expect(client.lists()).rejects.toThrow("the channel is closed");
  });
});

describe("a channel over a socket", () => {
  it("sends what it is given before the socket opens once it opens", async () => {
    const { origin } = await startServer();
    const client = new Client(socketChannel(openSocket(origin, origin)));
    expect(await client.get(note.link)).toEqual(note.bytes);
  });

  it("closes when the socket is refused, which fails the calls made before", async () => {
    const { origin } = await startServer();
    const socket = openSocket(origin, "http://example.com");
    socket.on("error", () => {});
    await expect(new Client(socketChannel(socket)).lists()).rejects.toThrow("the channel closed before the reply");
  });
});
