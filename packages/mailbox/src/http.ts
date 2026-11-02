import { encodeSchema, type JsonObject, type JsonSchemaValidator } from "@estoc/object";
import { type Transport, Undelivered } from "./mailbox.ts";
import { mailboxSchema } from "./schema.ts";

// Plain http is for the receiver's own machine alone, as in development or
// for a daemon beside the sender. Anywhere else, whoever is on the way would
// see when and how much arrives, and could hold messages back unseen.
const URL_PATTERN = "^(https://|http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?([/?#]|$))";

/**
 * The transport of HTTP mailboxes, whose data is `{"key", "url"}`. It posts
 * sealed bytes to the mailbox's url, and a 2xx response means they were
 * handed on. 404 and 410 reject as `gone`, 408, 429 and 5xx as `later`, any
 * other response as `refused`, and no response as `later`.
 */
export async function loadHttpTransport(validator: JsonSchemaValidator): Promise<Transport> {
  const url = { type: "string", format: "uri", pattern: URL_PATTERN };
  return { schema: await encodeSchema(mailboxSchema("HTTP mailbox", { url }, ["url"]), validator), deliver };
}

async function deliver(mailbox: JsonObject, sealed: Uint8Array): Promise<void> {
  const { url } = mailbox as { readonly url: string };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: sealed,
      // A redirect would take the bytes to a url that the mailbox does not
      // name, and that need not be one a mailbox may name. A browser does
      // not tell it from no answer, so it rejects as one.
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    throw new Undelivered("later", "the mailbox's server did not answer", { cause: error });
  }
  await response.body?.cancel();
  if (!response.ok) throw new Undelivered(kindOf(response.status), `the mailbox's server answered ${response.status}`);
}

function kindOf(status: number): Undelivered["kind"] {
  if (status === 404 || status === 410) return "gone";
  if (status === 408 || status === 429 || status >= 500) return "later";
  return "refused";
}
