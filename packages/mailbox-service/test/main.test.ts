import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile, stat } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { openTestMailbox } from "../src/smoke.ts";
import { makeTemporaryPath } from "./fixtures.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const smoke = fileURLToPath(new URL("../src/smoke.ts", import.meta.url));

/** Runs `script` with `args`, and the environment with `settings`, to its end. */
async function run(script: string, args: readonly string[], settings: Readonly<Record<string, string>> = {}) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...settings } });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.resume();
  const [code] = await once(child, "exit");
  return { code, stderr };
}

/** Settings for a service at a free port of 127.0.0.1, which keeps its key and its database in a folder of its own. */
async function settingsAtFreePort() {
  const database = await makeTemporaryPath();
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  return {
    MAILBOX_ORIGIN: `http://127.0.0.1:${port}`,
    MAILBOX_KEY: join(dirname(database), "key"),
    MAILBOX_DATABASE: database,
    MAILBOX_PORT: String(port),
  };
}

/** Starts main.ts with `settings`, resolving once it serves. */
async function start(settings: Readonly<Record<string, string>>) {
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, ...settings },
    stdio: ["ignore", "pipe", "inherit"],
  });
  onTestFinished(() => void child.kill());
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("exit", (code) => reject(new Error(`main.ts exited with ${code}`)));
  });
  child.stdout.resume();
  return {
    /** Asks it to stop, resolving to its exit code once it has. */
    async stop() {
      child.kill("SIGTERM");
      const [code] = await once(child, "exit");
      return code;
    },
  };
}

describe("main.ts", { timeout: 20_000 }, () => {
  it("serves the service that the environment sets up, which passes the smoke test", async () => {
    const settings = await settingsAtFreePort();
    expect((await run(main, ["key", settings.MAILBOX_KEY])).code).toBe(0);
    const service = await start(settings);
    expect(await run(smoke, [settings.MAILBOX_ORIGIN])).toEqual({ code: 0, stderr: "" });
    expect(await service.stop()).toBe(0);
  });

  it("keeps what waits at a mailbox when started again", async () => {
    const settings = await settingsAtFreePort();
    await run(main, ["key", settings.MAILBOX_KEY]);
    const first = await start(settings);
    const mailbox = await openTestMailbox(settings.MAILBOX_ORIGIN);
    expect((await fetch(mailbox.url, { method: "POST", body: new Uint8Array([1]) })).status).toBe(204);
    expect(await first.stop()).toBe(0);
    const second = await start(settings);
    expect(await mailbox.pickUp()).toEqual([new Uint8Array([1])]);
    expect(await second.stop()).toBe(0);
  });

  it("refuses to start without a key file, and makes no database", async () => {
    const settings = await settingsAtFreePort();
    const { code, stderr } = await run(main, [], settings);
    expect(code).toBe(1);
    expect(stderr).toContain(`no such file or directory, open '${settings.MAILBOX_KEY}'`);
    await expect(access(settings.MAILBOX_DATABASE)).rejects.toThrow(/ENOENT/);
  });
});

describe("main.ts key", { timeout: 20_000 }, () => {
  it("writes a key file that its owner alone reads, and refuses to write over one", async () => {
    const path = join(dirname(await makeTemporaryPath()), "key");
    expect((await run(main, ["key", path])).code).toBe(0);
    const key = await readFile(path, "utf8");
    expect(key).toMatch(/^[0-9a-f]{64}\n$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const { code, stderr } = await run(main, ["key", path]);
    expect(code).toBe(1);
    expect(stderr).toContain("EEXIST");
    expect(await readFile(path, "utf8")).toBe(key);
  });
});
