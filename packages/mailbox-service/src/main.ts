import { access, open } from "node:fs/promises";
import { ed25519, identityKit } from "@estoc/identity";
import { Keyring } from "@estoc/keyring";
import { Store } from "@estoc/store";
import { SqliteBackend } from "@estoc/store/sqlite";
import { serve } from "./node.ts";
import { setUpNotary } from "./notary.ts";
import { loadMailboxService } from "./server.ts";
import { SqliteAccounts, SqliteMailboxes } from "./sqlite.ts";

const DAY = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;

const [command, ...rest] = process.argv.slice(2);
if (command === undefined) await start();
else if (command === "setup" && rest.length === 0) await setUp();
else {
  console.error("Usage: main.ts, or main.ts setup, each set up by the environment");
  process.exitCode = 1;
}

async function start(): Promise<void> {
  const origin = settingNamed("MAILBOX_ORIGIN");
  const database = settingNamed("MAILBOX_DATABASE");
  const port = Number(settingNamed("MAILBOX_PORT"));
  const terms = {
    retention: Number(process.env.MAILBOX_RETENTION ?? 30 * DAY),
    quota: Number(process.env.MAILBOX_QUOTA ?? 64 * MIB),
    size: Number(process.env.MAILBOX_SIZE ?? MIB),
  };
  // SQLite makes a file that is missing, which would be a service that is not set up.
  await access(database);
  const backend = new SqliteBackend(database);
  const accounts = new SqliteAccounts(database);
  const mailboxes = new SqliteMailboxes(database);
  const store = new Store(backend);
  const keyring = new Keyring(store, identityKit.secretKeys);
  const service = await loadMailboxService(keyring, {
    origin,
    store,
    accounts,
    mailboxes,
    terms,
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
    for (const file of [backend, accounts, mailboxes]) file.close();
  };
  process.once("SIGTERM", stop).once("SIGINT", stop);
  // Whoever waits for this line can ask it to stop from then on.
  console.log(`${origin} is served at ${server.origin} as ${service.identifier}`);
}

async function setUp(): Promise<void> {
  const database = settingNamed("MAILBOX_DATABASE");
  // The database holds the key of the service. SQLite gives the files it makes beside a database
  // the database's mode.
  await (await open(database, "wx", 0o600)).close();
  const backend = new SqliteBackend(database);
  try {
    const store = new Store(backend);
    const keyring = new Keyring(store, identityKit.secretKeys);
    const root = await keyring.generate(ed25519);
    const signedIdentity = await setUpNotary(keyring, root.link, { store, at: Date.now() });
    console.log(signedIdentity.identity.identifier);
  } finally {
    backend.close();
  }
}

function settingNamed(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}
