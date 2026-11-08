import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile, stat } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519, eip191, loadIdentity, solanaOffchain } from "@estoc/identity";
import { json, objectsOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { MemoryBackend, PrivateStore, Store } from "@estoc/store";
import { SqliteBackend } from "@estoc/store/sqlite";
import { describe, expect, it, onTestFinished } from "vitest";
import { openTestMailbox } from "../src/smoke.ts";
import { makeTemporaryPath } from "./fixtures.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const smoke = fileURLToPath(new URL("../src/smoke.ts", import.meta.url));

/** Runs `script` with `args`, and the environment with `settings`, to its end. */
async function run(script: string, args: readonly string[], settings: Readonly<Record<string, string>> = {}) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...settings } });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

/** Settings for a service at a free port of 127.0.0.1, which keeps its private store and its database in a folder of its own. */
async function settingsAtFreePort() {
  const database = await makeTemporaryPath();
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  return {
    MAILBOX_ORIGIN: `http://127.0.0.1:${port}`,
    MAILBOX_PRIVATE_STORE: join(dirname(database), "private.db"),
    MAILBOX_DATABASE: database,
    MAILBOX_PORT: String(port),
  };
}

/** Starts main.ts with `settings`, resolving once it serves, with the line it writes then. */
async function start(settings: Readonly<Record<string, string>>) {
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, ...settings },
    stdio: ["ignore", "pipe", "inherit"],
  });
  onTestFinished(() => void child.kill());
  const line = await new Promise<string>((resolve, reject) => {
    child.stdout.setEncoding("utf8").once("data", resolve);
    child.once("exit", (code) => reject(new Error(`main.ts exited with ${code}`)));
  });
  child.stdout.resume();
  return {
    line,
    /** Asks it to stop, resolving to its exit code once it has. */
    async stop() {
      child.kill("SIGTERM");
      const [code] = await once(child, "exit");
      return code;
    },
  };
}

/** The Secret Keys in the private store at `path`. */
async function secretKeysAt(path: string) {
  const { secretKeys } = await loadIdentity(defaultValidator, [ed25519, eip191, solanaOffchain]);
  const backend = new SqliteBackend(path);
  onTestFinished(() => backend.close());
  const privateStore = new PrivateStore(new Store(json, new MemoryBackend()), backend);
  const selection = objectsOf(secretKeys.schema);
  const found = [];
  for await (const record of privateStore.records()) {
    const object = await selection.read(record, privateStore);
    if (object !== undefined) found.push(object);
  }
  return found;
}

describe("main.ts", { timeout: 20_000 }, () => {
  it("serves the service that the environment sets up, which passes the smoke test", async () => {
    const settings = await settingsAtFreePort();
    expect((await run(main, ["key", settings.MAILBOX_PRIVATE_STORE])).code).toBe(0);
    const service = await start(settings);
    expect(await run(smoke, [settings.MAILBOX_ORIGIN])).toMatchObject({ code: 0, stderr: "" });
    expect(await service.stop()).toBe(0);
  });

  it("keeps its root, and what waits at a mailbox, when started again", async () => {
    const settings = await settingsAtFreePort();
    const { stdout } = await run(main, ["key", settings.MAILBOX_PRIVATE_STORE]);
    const root = stdout.trim();
    const first = await start(settings);
    expect(first.line).toContain(`as ${root}`);
    const mailbox = await openTestMailbox(settings.MAILBOX_ORIGIN);
    expect((await fetch(mailbox.url, { method: "POST", body: new Uint8Array([1]) })).status).toBe(204);
    expect(await first.stop()).toBe(0);
    const second = await start(settings);
    expect(second.line).toContain(`as ${root}`);
    expect(await mailbox.pickUp()).toEqual([new Uint8Array([1])]);
    expect(await second.stop()).toBe(0);
  });

  it("refuses to start without its private store, and makes no database", async () => {
    const settings = await settingsAtFreePort();
    const { code, stderr } = await run(main, [], settings);
    expect(code).toBe(1);
    expect(stderr).toContain(`no such file or directory, access '${settings.MAILBOX_PRIVATE_STORE}'`);
    await expect(access(settings.MAILBOX_PRIVATE_STORE)).rejects.toThrow(/ENOENT/);
    await expect(access(settings.MAILBOX_DATABASE)).rejects.toThrow(/ENOENT/);
  });

  it("refuses to start with a private store that holds no Secret Key", async () => {
    const settings = await settingsAtFreePort();
    new SqliteBackend(settings.MAILBOX_PRIVATE_STORE).close();
    const { code, stderr } = await run(main, [], settings);
    expect(code).toBe(1);
    expect(stderr).toContain(`${settings.MAILBOX_PRIVATE_STORE} holds 0 Secret Keys`);
  });
});

describe("main.ts key", { timeout: 20_000 }, () => {
  it("makes a private store that its owner alone reads, holding one Secret Key, whose key it prints", async () => {
    const path = join(dirname(await makeTemporaryPath()), "private.db");
    const { code, stdout } = await run(main, ["key", path]);
    expect(code).toBe(0);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const [secretKey, ...others] = await secretKeysAt(path);
    expect(others).toEqual([]);
    expect(stdout).toBe(`${secretKey?.data.key.$link}\n`);
  });

  it("refuses to write over a file that is there", async () => {
    const path = join(dirname(await makeTemporaryPath()), "private.db");
    await run(main, ["key", path]);
    const bytes = await readFile(path);
    const { code, stderr } = await run(main, ["key", path]);
    expect(code).toBe(1);
    expect(stderr).toContain("EEXIST");
    expect(await readFile(path)).toEqual(bytes);
  });
});
