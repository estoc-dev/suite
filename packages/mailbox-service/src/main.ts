import { access, open } from "node:fs/promises";
import { ed25519, eip191, loadIdentity, type SecretKeyObject, solanaOffchain } from "@estoc/identity";
import { type Link, objectsOf } from "@estoc/object";
import { MemoryBackend, PrivateStore, SecretStore, Store } from "@estoc/store";
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
  const secretKey = await secretKeyIn(new SecretStore(store, secretBackend), secretStorePath);
  const service = await loadMailboxService(secretKey.signer, {
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
  console.log(`${origin} is served at ${server.origin} as ${secretKey.key.link}`);
}

async function makeSecretStore(path: string): Promise<void> {
  // SQLite gives the files it makes beside a database the database's mode.
  await (await open(path, "wx", 0o600)).close();
  const backend = new SqliteBackend(path);
  try {
    const { secretKeys } = loadIdentity(schemes);
    const secretKey = secretKeys.encode(ed25519, crypto.getRandomValues(new Uint8Array(32)));
    const secretStore = new SecretStore(new Store(new MemoryBackend()), backend);
    await secretStore.write({ secrets: [secretKey.link], blobs: secretKey.blobs });
    console.log(secretKey.key.link);
  } finally {
    backend.close();
  }
}

async function secretKeyIn(secretStore: SecretStore, path: string): Promise<SecretKeyObject> {
  const { secretKeys } = loadIdentity(schemes);
  const selection = objectsOf(secretKeys.schema);
  const links: Link<unknown>[] = [];
  for await (const secret of secretStore.secrets()) {
    const secretKey = await selection.read(secret, secretStore);
    if (secretKey !== undefined) links.push(secretKey.link);
  }
  const [link, ...others] = links;
  if (link === undefined || others.length > 0)
    throw new Error(`${path} holds ${links.length} Secret Keys, where the service takes one`);
  return secretKeys.read(link, secretStore);
}

function settingNamed(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}
