#!/usr/bin/env node
import { MailboxKey, mailboxFrom } from "@estoc/mailbox";
import { loadHttpTransport } from "@estoc/mailbox/http";
import { encodeObject, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { base64urlnopad, hex } from "@scure/base";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readBundleAt, writeBundleTo } from "./files.ts";
import { TestInbox } from "./inbox.ts";
import { TestMailboxServer } from "./server.ts";

const USAGE = `usage:
  http-test-mailbox serve <dir> [--port <port>]
  http-test-mailbox init <dir> [--server <url>]
  http-test-mailbox send <mailbox> <bundle>
  http-test-mailbox receive <dir>`;

const SECRET = "secret";
const MAILBOX = "mailbox.json";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "8080" },
    server: { type: "string", default: "http://127.0.0.1:8080" },
  },
});
const http = await loadHttpTransport(defaultValidator);

async function serve(dir: string): Promise<void> {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${values.port} is not a port`);
  console.log((await TestMailboxServer.listen({ dir, port })).url);
}

async function init(dir: string): Promise<void> {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const key = await MailboxKey.fromSecretKey(secret);
  const queue = base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(16)));
  const url = `${values.server.replace(/\/+$/, "")}/${queue}`;
  const mailbox = encodeObject(http.schema, { key: hex.encode(key.publicKey), url });
  await mkdir(dir, { recursive: true });
  // The secret goes first, and not over one already there, so that no
  // mailbox is written for a key that is lost.
  await writeFile(join(dir, SECRET), secret, { flag: "wx", mode: 0o600 });
  await writeFile(join(dir, MAILBOX), mailbox.bytes);
  console.log(new TextDecoder().decode(mailbox.bytes));
}

async function send(mailbox: string, bundle: string): Promise<void> {
  const to = await mailboxFrom(await readFile(mailbox), { transports: [http] });
  const sent = await readBundleAt(bundle);
  await to.send({ bytes: sent.root }, sent.blobs());
  console.log(`sent ${sent.link}`);
}

async function receive(dir: string): Promise<void> {
  const key = await MailboxKey.fromSecretKey(new Uint8Array(await readFile(join(dir, SECRET))));
  const inbox = TestInbox.from(await readFile(join(dir, MAILBOX)), key, http);
  const folderOf = (link: Link<unknown>) => join(dir, "inbox", link.slice("sha256:".length));
  const taken = await inbox.take((bundle) => writeBundleTo(folderOf(bundle.link), bundle));
  for (const message of taken) {
    console.log("bundle" in message ? `kept ${folderOf(message.bundle.link)}` : `refused ${message.id}: ${reason(message.refused)}`);
  }
  if (taken.length === 0) console.log("nothing waits");
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const commands = new Map<string, [number, (...operands: string[]) => Promise<void>]>([
  ["serve", [1, serve]],
  ["init", [1, init]],
  ["send", [2, send]],
  ["receive", [1, receive]],
]);

const [command = "", ...operands] = positionals;
const run = commands.get(command);
if (run === undefined || run[0] !== operands.length) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  try {
    await run[1](...operands);
  } catch (error) {
    console.error(reason(error));
    process.exitCode = 1;
  }
}
