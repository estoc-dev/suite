import { Agent, request } from "node:http";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readBody } from "../src/http.ts";
import { serve } from "../src/node.ts";

/** A handler served at 127.0.0.1 that reads a body of up to 1 KiB, or none at `/unread`, or throws at `/throw`. */
async function startServer() {
  const server = await serve(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/throw") throw new Error("the handler throws");
    if (pathname === "/unread") return new Response(null, { status: 404 });
    const body = await readBody(request.body, 1024);
    return new Response(body === undefined ? null : `${body.length}`, { status: body === undefined ? 413 : 200 });
  }, 0);
  onTestFinished(() => server.close());
  return server;
}

/** A client that sends a request once the one before is sent whole and answered. */
function oneAtATime() {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  onTestFinished(() => agent.destroy());
  return {
    /** Posts `body` to `url`, resolving to the status and the text of the answer. */
    post: (url: string, body: Uint8Array) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const outgoing = request(url, { method: "POST", agent }, async (incoming) => {
          let text = "";
          for await (const chunk of incoming.setEncoding("utf8")) text += chunk;
          resolve({ status: incoming.statusCode ?? 0, text });
        });
        outgoing.on("error", reject).end(body);
      }),
  };
}

describe("serve", () => {
  it.each([
    ["reads no more of its body than a limit", "/", 413],
    ["does not read its body", "/unread", 404],
  ])(
    "answers a request whose handler %s, and reads the rest, which the client's next request waits for",
    async (_, path, status) => {
      const { origin } = await startServer();
      const client = oneAtATime();
      expect(await client.post(`${origin}${path}`, new Uint8Array(4 * 1024 * 1024))).toMatchObject({ status });
      expect(await client.post(`${origin}/`, new Uint8Array(3))).toEqual({ status: 200, text: "3" });
    },
  );

  it("answers 500 when the handler throws", async () => {
    const { origin } = await startServer();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    expect(await oneAtATime().post(`${origin}/throw`, new Uint8Array(3))).toMatchObject({ status: 500 });
    expect(error).toHaveBeenCalledWith(new Error("the handler throws"));
  });
});
