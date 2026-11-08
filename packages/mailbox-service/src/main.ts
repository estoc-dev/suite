import { access, open } from "node:fs/promises";
import { ed25519, eip191, loadIdentity, type SecretKeyObject, solanaOffchain } from "@estoc/identity";
import { json, type Link, objectsOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
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
else if (command === "key" && path !== undefined && rest.length === 0) await makeKeys(path);
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
 * @throws when the key file holds no Secret Key or more than one.
 */
async function start(): Promise<void> {
  const origin = settingNamed("MAILBOX_ORIGIN");
  const keysPath = settingNamed("MAILBOX_KEYS");
  const database = settingNamed("MAILBOX_DATABASE");
  const port = Number(settingNamed("MAILBOX_PORT"));
  const terms = {
    retention: Number(process.env.MAILBOX_RETENTION ?? 30 * DAY),
    quota: Number(process.env.MAILBOX_QUOTA ?? 64 * MIB),
    size: Number(process.env.MAILBOX_SIZE ?? MIB),
  };
  // SQLite makes a file that is missing, which would be a new service with no key.
  await access(keysPath);
  const keysBackend = new SqliteBackend(keysPath);
  const backend = new SqliteBackend(database);
  const accounts = new SqliteAccounts(database);
  const mailboxes = new SqliteMailboxes(database);
  const store = new Store(json, backend);
  const secretKey = await secretKeyIn(new PrivateStore(store, keysBackend), keysPath);
  const service = await loadMailboxService(secretKey.signer, {
    origin,
    store,
    accounts,
    mailboxes,
    terms,
    validator: defaultValidator,
    schemes,
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
  console.log(`${origin} is served at ${server.origin} as ${secretKey.key.link}`);
  const stop = async () => {
    await server.close();
    for (const file of [keysBackend, backend, accounts, mailboxes]) file.close();
  };
  process.once("SIGTERM", stop).once("SIGINT", stop);
}

/**
 * Makes a private store at `path` that its owner alone reads, holding a new
 * Ed25519 Secret Key for the service's identity, and prints the link of its
 * key.
 *
 * @throws when a file is at `path`.
 */
async function makeKeys(path: string): Promise<void> {
  // SQLite gives the files it makes beside a database the database's mode.
  await (await open(path, "wx", 0o600)).close();
  const backend = new SqliteBackend(path);
  try {
    const { secretKeys } = await loadIdentity(defaultValidator, schemes);
    const secretKey = secretKeys.encode(ed25519, crypto.getRandomValues(new Uint8Array(32)));
    const keys = new PrivateStore(new Store(json, new MemoryBackend()), backend);
    await keys.write({ records: [secretKey], blobs: secretKey.blobs });
    console.log(secretKey.key.link);
  } finally {
    backend.close();
  }
}

/**
 * The one Secret Key in `keys`, the private store at `path`.
 *
 * @throws when `keys` holds no Secret Key or more than one.
 */
async function secretKeyIn(keys: PrivateStore, path: string): Promise<SecretKeyObject> {
  const { secretKeys } = await loadIdentity(defaultValidator, schemes);
  const selection = objectsOf(secretKeys.schema);
  const links: Link<SecretKeyObject>[] = [];
  for await (const record of keys.records()) {
    const object = await selection.read(record, keys);
    if (object !== undefined) links.push(object.link as Link<SecretKeyObject>);
  }
  const [link, ...others] = links;
  if (link === undefined || others.length > 0)
    throw new Error(`${path} holds ${links.length} Secret Keys, where the service takes one`);
  return secretKeys.read(link, keys);
}

function settingNamed(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}
