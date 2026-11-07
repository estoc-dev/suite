import { readFile, writeFile } from "node:fs/promises";
import { ed25519, eip191, SoftwareSigner, solanaOffchain } from "@estoc/identity";
import { json } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { Store } from "@estoc/store";
import { SqliteBackend } from "@estoc/store/sqlite";
import { hex } from "@scure/base";
import { serve } from "./node.ts";
import { loadMailboxService } from "./server.ts";
import { SqliteAccounts, SqliteMailboxes } from "./sqlite.ts";

const DAY = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;

const [command, path, ...rest] = process.argv.slice(2);
if (command === undefined) await start();
else if (command === "key" && path !== undefined && rest.length === 0) await makeKey(path);
else {
  console.error("Usage: main.ts, set up by the environment, or main.ts key <path>");
  process.exitCode = 1;
}

/**
 * Serves the mailbox service that the environment sets up, until the
 * process is asked to stop.
 *
 * @throws when a setting without a default is not set, or the key file is
 *   missing.
 */
async function start(): Promise<void> {
  const origin = settingNamed("MAILBOX_ORIGIN");
  const keyPath = settingNamed("MAILBOX_KEY");
  const database = settingNamed("MAILBOX_DATABASE");
  const port = Number(settingNamed("MAILBOX_PORT"));
  const terms = {
    retention: Number(process.env.MAILBOX_RETENTION ?? 30 * DAY),
    quota: Number(process.env.MAILBOX_QUOTA ?? 64 * MIB),
    size: Number(process.env.MAILBOX_SIZE ?? MIB),
  };
  const signer = SoftwareSigner.fromSecretKey(ed25519, hex.decode((await readFile(keyPath, "utf8")).trim()));
  const backend = new SqliteBackend(database);
  const accounts = new SqliteAccounts(database);
  const mailboxes = new SqliteMailboxes(database);
  const service = await loadMailboxService(signer, {
    origin,
    store: new Store(json, backend),
    accounts,
    mailboxes,
    terms,
    validator: defaultValidator,
    schemes: [ed25519, eip191, solanaOffchain],
  });
  const server = await serve(async (request) => {
    const since = performance.now();
    let status = 500;
    try {
      const response = await service.fetch(request);
      status = response.status;
      return response;
    } finally {
      console.log(`${request.method} ${status} ${Math.round(performance.now() - since)} ms`);
    }
  }, port);
  console.log(`${origin} is served at ${server.origin}`);
  const stop = async () => {
    await server.close();
    for (const file of [backend, accounts, mailboxes]) file.close();
  };
  process.once("SIGTERM", stop).once("SIGINT", stop);
}

/** Writes a new secret key for the service's identity to `path`, readable by its owner alone, unless a file is there. */
async function makeKey(path: string): Promise<void> {
  const secretKey = crypto.getRandomValues(new Uint8Array(32));
  await writeFile(path, `${hex.encode(secretKey)}\n`, { flag: "wx", mode: 0o600 });
}

function settingNamed(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}
