import { encodeSchema, type JsonObject, type JsonSchemaValidator } from "@estoc/object";
import type { Transport } from "./mailbox.ts";
import { mailboxSchema } from "./schema.ts";

// Plain http is for the receiver's own machine alone, as in development or
// for a daemon beside the sender. Anywhere else, whoever is on the way would
// see when and how much arrives, and could hold messages back unseen.
const URL_PATTERN = "^(https://|http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?([/?#]|$))";

/**
 * The transport of HTTP mailboxes, whose data is `{"key", "url"}`. It posts
 * sealed bytes to the mailbox's url, and a 2xx response means they were
 * handed on.
 */
export async function loadHttpTransport(validator: JsonSchemaValidator): Promise<Transport> {
  const url = { type: "string", format: "uri", pattern: URL_PATTERN };
  return { schema: await encodeSchema(mailboxSchema("HTTP mailbox", { url }, ["url"]), validator), deliver };
}

async function deliver(mailbox: JsonObject, sealed: Uint8Array): Promise<void> {
  const { url } = mailbox as { readonly url: string };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: sealed,
    // A redirect would take the bytes to a url that the mailbox does not
    // name, and that need not be one a mailbox may name.
    redirect: "error",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`the mailbox's server answered ${response.status}`);
}
