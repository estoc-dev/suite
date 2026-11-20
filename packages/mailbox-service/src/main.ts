import { access, open } from "node:fs/promises";
import { ed25519, eip191, loadIdentity, solanaOffchain } from "@estoc/identity";
import { Keyring } from "@estoc/keyring";
import type { Link } from "@estoc/object";
import { MemoryBackend, PrivateStore, Store } from "@estoc/store";
import { SqliteBackend } from "@estoc/store/sqlite";
import { serve } from "./node.ts";
import { loadMailboxService } from "./server.ts";
import { SqliteAccounts, SqliteMailboxes } from "./sqlite.ts";

const DAY = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;
const schemes = [ed25519, eip191, solanaOffchain];

const [command, path, ...rest] = process.argv.slice(2);
if (command === undefined) await start();
else if (command === "key" && path !== undefined && rest.length === 0) await makeSecretStore(path);
else {
  console.error("Usage: main.ts, set up by the environment, or main.ts key <path>");
  process.exitCode = 1;
}

async function start(): Promise<void> {
  const origin = settingNamed("MAILBOX_ORIGIN");
  const secretStorePath = settingNamed("MAILBOX_SECRET_STORE");
  const privateStorePath = settingNamed("MAILBOX_PRIVATE_STORE");
  const database = settingNamed("MAILBOX_DATABASE");
  const port = Number(settingNamed("MAILBOX_PORT"));
  const terms = {
    retention: Number(process.env.MAILBOX_RETENTION ?? 30 * DAY),
    quota: Number(process.env.MAILBOX_QUOTA ?? 64 * MIB),
    size: Number(process.env.MAILBOX_SIZE ?? MIB),
  };
  // SQLite makes a file that is missing, which would be a new service with no key.
  await access(secretStorePath);
  const secretBackend = new SqliteBackend(secretStorePath);
  const privateBackend = new SqliteBackend(privateStorePath);
  const backend = new SqliteBackend(database);
  const accounts = new SqliteAccounts(database);
  const mailboxes = new SqliteMailboxes(database);
  const store = new Store(backend);
  const keyring = new Keyring(store, secretBackend, loadIdentity(schemes).secretKeys);
  const key = await keyIn(keyring, secretStorePath);
  const signer = await keyring.signerFor(key);
  if (signer === undefined) throw new Error(`${secretStorePath} lists ${key} and gives no signer for it`);
  const service = await loadMailboxService(signer, {
    origin,
    store,
    privateStore: new PrivateStore(store, privateBackend),
    accounts,
    mailboxes,
    terms,
    schemes,
  });
  const server = await serve(
    async (request) => {
      const since = performance.now();
      let status = 500;
      try {
        const response = await service.fetch(request);
        status = response.status;
        return response;
      } finally {
        console.log(`${request.method} ${status} ${Math.round(performance.now() - since)} ms`);
      }
    },
    port,
    process.env.MAILBOX_HOST,
  );
  const stop = async () => {
    await server.close();
    for (const file of [secretBackend, privateBackend, backend, accounts, mailboxes]) file.close();
  };
  process.once("SIGTERM", stop).once("SIGINT", stop);
  // Whoever waits for this line can ask it to stop from then on.
  console.log(`${origin} is served at ${server.origin} as ${key}`);
}

async function makeSecretStore(path: string): Promise<void> {
  // SQLite gives the files it makes beside a database the database's mode.
  await (await open(path, "wx", 0o600)).close();
  const backend = new SqliteBackend(path);
  try {
    const keyring = new Keyring(new Store(new MemoryBackend()), backend, loadIdentity(schemes).secretKeys);
    console.log((await keyring.generate(ed25519)).link);
  } finally {
    backend.close();
  }
}

async function keyIn(keyring: Keyring, path: string): Promise<Link<unknown>> {
  const keys: Link<unknown>[] = [];
  for await (const link of keyring.keys()) keys.push(link);
  const [key, ...others] = keys;
  if (key === undefined || others.length > 0)
    throw new Error(`${path} holds ${keys.length} Secret Keys, where the service takes one`);
  return key;
}

function settingNamed(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}
