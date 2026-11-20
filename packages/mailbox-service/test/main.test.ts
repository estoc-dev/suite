import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isSameKey, loadIdentity } from "@estoc/identity";
import { Keyring } from "@estoc/keyring";
import { PrivateStore, Store } from "@estoc/store";
import { SqliteBackend } from "@estoc/store/sqlite";
import { assert, describe, expect, it, onTestFinished } from "vitest";
import { openTestMailbox } from "../src/smoke.ts";
import { makeTemporaryPath, recordedObjectsIn, schemes, signedIdentities } from "./fixtures.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const smoke = fileURLToPath(new URL("../src/smoke.ts", import.meta.url));

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

async function settingsAtFreePort() {
  const database = await makeTemporaryPath();
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  return {
    MAILBOX_ORIGIN: `http://127.0.0.1:${port}`,
    MAILBOX_SECRET_STORE: join(dirname(database), "secret.db"),
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
    async stop() {
      child.kill("SIGTERM");
      const [code] = await once(child, "exit");
      return code;
    },
  };
}

type Settings = Awaited<ReturnType<typeof settingsAtFreePort>>;

const filesIn = (settings: Settings) =>
  [settings.MAILBOX_SECRET_STORE, settings.MAILBOX_PRIVATE_STORE, settings.MAILBOX_DATABASE] as const;

function openBackend(path: string) {
  const backend = new SqliteBackend(path);
  onTestFinished(() => backend.close());
  return backend;
}

function openStores(settings: Settings) {
  const store = new Store(openBackend(settings.MAILBOX_DATABASE));
  return {
    store,
    privateStore: new PrivateStore(store, openBackend(settings.MAILBOX_PRIVATE_STORE)),
    keyring: new Keyring(store, openBackend(settings.MAILBOX_SECRET_STORE), loadIdentity(schemes).secretKeys),
  };
}

async function replaceWithEmptyDatabase(path: string) {
  await rm(path);
  new SqliteBackend(path).close();
}

describe("main.ts", { timeout: 20_000 }, () => {
  it("serves the service that the environment sets up, which passes the smoke test", async () => {
    const settings = await settingsAtFreePort();
    expect((await run(main, ["setup"], settings)).code).toBe(0);
    const service = await start(settings);
    expect(await run(smoke, [settings.MAILBOX_ORIGIN])).toMatchObject({ code: 0, stderr: "" });
    expect(await service.stop()).toBe(0);
  });

  it("keeps its root, and what waits at a mailbox, when started again", async () => {
    const settings = await settingsAtFreePort();
    const { stdout } = await run(main, ["setup"], settings);
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

  it("listens at the address that MAILBOX_HOST names", async () => {
    const settings = await settingsAtFreePort();
    await run(main, ["setup"], settings);
    const service = await start({ ...settings, MAILBOX_HOST: "::1" });
    expect(service.line).toContain(`is served at http://[::1]:${settings.MAILBOX_PORT} as`);
    expect(await service.stop()).toBe(0);
  });

  it("refuses to start before it is set up, and makes none of its files", async () => {
    const settings = await settingsAtFreePort();
    const { code, stderr } = await run(main, [], settings);
    expect(code).toBe(1);
    expect(stderr).toContain(`no such file or directory, access '${settings.MAILBOX_SECRET_STORE}'`);
    for (const path of filesIn(settings)) await expect(access(path)).rejects.toThrow(/ENOENT/);
  });

  it("refuses to start with a private store that records no identity version", async () => {
    const settings = await settingsAtFreePort();
    await run(main, ["setup"], settings);
    await replaceWithEmptyDatabase(settings.MAILBOX_PRIVATE_STORE);
    const { code, stderr } = await run(main, [], settings);
    expect(code).toBe(1);
    expect(stderr).toContain("the private store records identity versions of 0 identities");
  });

  it("refuses to start with a secret store that does not hold the Secret Key of its root", async () => {
    const settings = await settingsAtFreePort();
    const { stdout } = await run(main, ["setup"], settings);
    await replaceWithEmptyDatabase(settings.MAILBOX_SECRET_STORE);
    const { code, stderr } = await run(main, [], settings);
    expect(code).toBe(1);
    expect(stderr).toContain(`the keyring does not hold the Secret Key of ${stdout.trim()}`);
  });
});

describe("main.ts setup", { timeout: 20_000 }, () => {
  it("makes files that their owner alone reads, recording an identity version whose root the secret store holds, and prints its identifier", async () => {
    const settings = await settingsAtFreePort();
    const { code, stdout } = await run(main, ["setup"], settings);
    expect(code).toBe(0);
    for (const path of filesIn(settings)) expect((await stat(path)).mode & 0o777).toBe(0o600);
    const { store, privateStore, keyring } = openStores(settings);
    const [recorded, ...others] = await recordedObjectsIn(privateStore);
    assert.exists(recorded);
    expect(others).toEqual([]);
    const { identity } = await signedIdentities.read(recorded, store);
    expect(stdout).toBe(`${identity.identifier}\n`);
    const signer = await keyring.signerFor(identity.root.link);
    assert.exists(signer);
    expect(isSameKey(signer.key, identity.root)).toBe(true);
  });

  it.each(["MAILBOX_SECRET_STORE", "MAILBOX_PRIVATE_STORE", "MAILBOX_DATABASE"] as const)(
    "refuses to write over the file at %s, and makes neither of the others",
    async (name) => {
      const settings = await settingsAtFreePort();
      await writeFile(settings[name], "there");
      const { code, stderr } = await run(main, ["setup"], settings);
      expect(code).toBe(1);
      expect(stderr).toContain("EEXIST");
      expect(await readFile(settings[name], "utf8")).toBe("there");
      for (const path of filesIn(settings))
        if (path !== settings[name]) await expect(access(path)).rejects.toThrow(/ENOENT/);
    },
  );
});
