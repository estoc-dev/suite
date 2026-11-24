import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ed25519, identityKit } from "@estoc/identity";
import { heldKeys } from "@estoc/keyring";
import { decodeObject, type Link, LinkValue } from "@estoc/object";
import { Store } from "@estoc/store";
import { SqliteBackend } from "@estoc/store/sqlite";
import { assert, describe, expect, it, onTestFinished } from "vitest";
import { WebSocket } from "ws";
import { Client, socketChannel } from "../src/index.ts";
import { heldBlobSchema } from "../src/runtime.ts";
import { makeTemporaryFolder } from "./fixtures.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const sample = fileURLToPath(new URL("../src/sample.ts", import.meta.url));

async function run(script: string, args: readonly string[]) {
  const child = spawn(process.execPath, [script, ...args]);
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "exit");
  return { code, stderr };
}

/** Starts main.ts with `args`, resolving once it serves, with the origin it writes then. */
async function start(args: readonly string[]) {
  const child = spawn(process.execPath, [main, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  onTestFinished(() => void child.kill());
  const line = await new Promise<string>((resolve, reject) => {
    child.stdout.setEncoding("utf8").once("data", resolve);
    child.once("exit", (code) => reject(new Error(`main.ts exited with ${code}`)));
  });
  const [origin] = line.match(/http:\/\/127\.0\.0\.1:\d+/) ?? [];
  assert.exists(origin);
  return {
    origin,
    async stop() {
      child.kill("SIGTERM");
      const [code] = await once(child, "exit");
      return code;
    },
  };
}

async function blobsIn(database: string): Promise<Link<unknown>[]> {
  const backend = new SqliteBackend(database);
  try {
    const links: Link<unknown>[] = [];
    for await (const link of new Store(backend).blobs()) links.push(link);
    return links;
  } finally {
    backend.close();
  }
}

async function makePaths() {
  const folder = await makeTemporaryFolder();
  const pages = join(folder, "pages");
  await mkdir(pages);
  await writeFile(join(pages, "index.html"), "<!doctype html>");
  return { database: join(folder, "store.db"), pages };
}

describe("main.ts", { timeout: 20_000 }, () => {
  it("shows the store at its database to a page of the origin it writes, with the pages of its folder", async () => {
    const { database, pages } = await makePaths();
    expect(await run(sample, [database])).toEqual({ code: 0, stderr: "" });
    const blobs = await blobsIn(database);
    const runtime = await start([database, pages]);
    expect(await (await fetch(runtime.origin)).text()).toBe("<!doctype html>");
    const socket = new WebSocket(runtime.origin.replace("http", "ws"), { origin: runtime.origin });
    await once(socket, "open");
    const page = await new Client(socketChannel(socket)).page("Blobs", -3, 3);
    expect(page).toMatchObject({ start: blobs.length - 3, rowCount: blobs.length, blobCount: blobs.length });
    expect(page.rows.map((bytes) => decodeObject(bytes, heldBlobSchema).data.blob.link)).toEqual(blobs.slice(-3));
    socket.terminate();
    expect(await runtime.stop()).toBe(0);
  });

  it("shows the indexes of the suite, with the rows of what the sample recorded", async () => {
    const { database, pages } = await makePaths();
    expect(await run(sample, [database])).toEqual({ code: 0, stderr: "" });
    const runtime = await start([database, pages]);
    const socket = new WebSocket(runtime.origin.replace("http", "ws"), { origin: runtime.origin });
    onTestFinished(() => socket.terminate());
    await once(socket, "open");
    const client = new Client(socketChannel(socket));
    expect((await client.lists()).map(({ data }) => data.name).slice(4)).toEqual(["Held Keys", "Held Mailbox Keys"]);
    const sampleKey = identityKit.secretKeys.encode(ed25519, new Uint8Array(32).fill(2));
    const { rows } = await client.page("Held Keys", 0, 10);
    expect(rows.map((bytes) => decodeObject(bytes, heldKeys.rowSchema).data)).toEqual([
      { key: new LinkValue(sampleKey.key.link), secretKey: new LinkValue(sampleKey.link) },
    ]);
    expect(await client.page("Held Mailbox Keys", 0, 10)).toMatchObject({ rowCount: 0, rows: [] });
  });

  it("refuses to start without its database, and does not make it", async () => {
    const { database, pages } = await makePaths();
    const { code, stderr } = await run(main, [database, pages]);
    expect(code).toBe(1);
    expect(stderr).toContain("unable to open database file");
    await expect(access(database)).rejects.toThrow(/ENOENT/);
  });

  it("refuses to start at a database without the blobs table and leaves its schema unchanged", async () => {
    const { database, pages } = await makePaths();
    const other = new DatabaseSync(database);
    onTestFinished(() => other.close());
    other.exec("CREATE TABLE notes (text TEXT)");
    const { code, stderr } = await run(main, [database, pages]);
    expect(code).toBe(1);
    expect(stderr).toContain("no such table: blobs");
    expect(other.prepare("SELECT name FROM sqlite_schema").all()).toEqual([{ name: "notes" }]);
  });

  it("says how it is run when it is given no folder of pages", async () => {
    const { database } = await makePaths();
    expect(await run(main, [database])).toEqual({ code: 1, stderr: expect.stringContaining("Usage: main.ts") });
  });
});

describe("sample.ts", { timeout: 20_000 }, () => {
  it("writes posts, a photo and the records of them, and adds nothing when run again", async () => {
    const { database } = await makePaths();
    expect(await run(sample, [database])).toEqual({ code: 0, stderr: "" });
    const blobs = await blobsIn(database);
    expect(blobs.length).toBeGreaterThan(400);
    expect(await run(sample, [database])).toEqual({ code: 0, stderr: "" });
    expect(await blobsIn(database)).toEqual(blobs);
  });
});
