import { access, open, rm } from "node:fs/promises";
import { ed25519, eip191, loadIdentity, solanaOffchain } from "@estoc/identity";
import { Keyring } from "@estoc/keyring";
import { PrivateStore, Store } from "@estoc/store";
import { SqliteBackend } from "@estoc/store/sqlite";
import { serve } from "./node.ts";
import { loadMailboxService, setUpMailboxService } from "./server.ts";
import { SqliteAccounts, SqliteMailboxes } from "./sqlite.ts";

const DAY = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;
const schemes = [ed25519, eip191, solanaOffchain];

const [command, ...rest] = process.argv.slice(2);
if (command === undefined) await start();
else if (command === "setup" && rest.length === 0) await setUp();
else {
  console.error("Usage: main.ts, or main.ts setup, each set up by the environment");
  process.exitCode = 1;
}

async function start(): Promise<void> {
  const origin = settingNamed("MAILBOX_ORIGIN");
  const paths = pathsInSettings();
  const port = Number(settingNamed("MAILBOX_PORT"));
  const terms = {
    retention: Number(process.env.MAILBOX_RETENTION ?? 30 * DAY),
    quota: Number(process.env.MAILBOX_QUOTA ?? 64 * MIB),
    size: Number(process.env.MAILBOX_SIZE ?? MIB),
  };
  // SQLite makes a file that is missing, which would be a service that is not set up.
  for (const path of Object.values(paths)) await access(path);
  const secretBackend = new SqliteBackend(paths.secretStore);
  const privateBackend = new SqliteBackend(paths.privateStore);
  const backend = new SqliteBackend(paths.database);
  const accounts = new SqliteAccounts(paths.database);
  const mailboxes = new SqliteMailboxes(paths.database);
  const store = new Store(backend);
  const service = await loadMailboxService(new Keyring(store, secretBackend, loadIdentity(schemes).secretKeys), {
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
  console.log(`${origin} is served at ${server.origin} as ${service.identifier}`);
}

async function setUp(): Promise<void> {
  const paths = pathsInSettings();
  // SQLite gives the files it makes beside a database the database's mode.
  await makeFiles(Object.values(paths), 0o600);
  const secretBackend = new SqliteBackend(paths.secretStore);
  const privateBackend = new SqliteBackend(paths.privateStore);
  const backend = new SqliteBackend(paths.database);
  try {
    const store = new Store(backend);
    const keyring = new Keyring(store, secretBackend, loadIdentity(schemes).secretKeys);
    const root = await keyring.generate(ed25519);
    const privateStore = new PrivateStore(store, privateBackend);
    const signedIdentity = await setUpMailboxService(keyring, root.link, {
      store,
      privateStore,
      schemes,
      at: Date.now(),
    });
    console.log(signedIdentity.identity.identifier);
  } finally {
    for (const file of [secretBackend, privateBackend, backend]) file.close();
  }
}

async function makeFiles(paths: readonly string[], mode: number): Promise<void> {
  const made: string[] = [];
  try {
    for (const path of paths) {
      await (await open(path, "wx", mode)).close();
      made.push(path);
    }
  } catch (error) {
    await Promise.all(made.map((path) => rm(path)));
    throw error;
  }
}

function pathsInSettings() {
  return {
    secretStore: settingNamed("MAILBOX_SECRET_STORE"),
    privateStore: settingNamed("MAILBOX_PRIVATE_STORE"),
    database: settingNamed("MAILBOX_DATABASE"),
  };
}

function settingNamed(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}
