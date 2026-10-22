import { readBundle, writeBundle } from "@estoc/bundle";
import { SoftwareSigner } from "@estoc/identity";
import { encodeObject, encodeSchema, loadSignatures } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { readBundleAt, writeBundleTo } from "../src/index.ts";

// The commands run as a user runs them: Node on the TypeScript, in a folder
// of their own.
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "http-test-mailbox-"));
const run = (...args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], { cwd: dir });

const serving = spawn(process.execPath, [cli, "serve", "queues", "--port", "0"], { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
const [url] = (await once(createInterface({ input: serving.stdout }), "line")) as [string];
afterAll(async () => {
  serving.kill();
  await rm(dir, { recursive: true });
});

const signatures = await loadSignatures(defaultValidator);
const alice = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const note = await encodeSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" }, defaultValidator);
const hello = encodeObject(note, "hello, Bob");
const signature = await signatures.sign(hello, alice);

describe("the commands", () => {
  it("carry a bundle from send to receive, through the server", async () => {
    const { stdout: mailbox } = await run("init", "bob", "--server", url);
    expect(JSON.parse(mailbox)).toMatchObject({ data: { url: expect.stringMatching(new RegExp(`^${url}/[A-Za-z0-9_-]{22}$`)) } });
    await writeBundleTo(join(dir, "hello"), readBundle(writeBundle(signature, [hello.bytes, signature.identity.bytes])));
    expect((await run("send", join("bob", "mailbox.json"), "hello")).stdout).toBe(`sent ${signature.link}\n`);
    const folder = join("bob", "inbox", signature.link.slice("sha256:".length));
    expect((await run("receive", "bob")).stdout).toBe(`kept ${folder}\n`);
    const kept = await readBundleAt(join(dir, folder));
    expect(kept.get(hello.link)).toEqual(hello.bytes);
    expect((await run("receive", "bob")).stdout).toBe("nothing waits\n");
  });

  it("init a mailbox whose secret only its owner reads, and not over one already there", async () => {
    await run("init", "carol", "--server", url);
    const secret = join(dir, "carol", "secret");
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
    const before = await readFile(secret);
    await expect(run("init", "carol", "--server", url)).rejects.toMatchObject({ code: 1 });
    expect(await readFile(secret)).toEqual(before);
  });

  it("give their usage for a command they do not know", async () => {
    await expect(run("fetch", "bob")).rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/^usage:/) });
    await expect(run("send", "bob")).rejects.toMatchObject({ code: 2 });
  });
});
