import type { ValueMap } from "@estoc/object";
import { string } from "@estoc/schema";
import { type Transport, UndeliveredMessage } from "./mailbox.ts";
import { mailboxSchema } from "./schema.ts";

// Plain http is for the receiver's own machine alone, as in development or
// for a daemon beside the sender. Anywhere else, whoever is on the way would
// see when and how much arrives, and could hold messages back unseen.
const allowedUrl = /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?([/?#]|$))/;

/**
 * The body goes as `application/octet-stream`, so a server that browsers post to answers their CORS
 * preflight for it.
 */
export const httpTransport = {
  schema: mailboxSchema("HTTP mailbox", { url: string() }),
  deliver,
} satisfies Transport;

async function deliver(mailbox: ValueMap, ciphertext: Uint8Array): Promise<void> {
  const { url } = mailbox as { readonly url: string };
  if (!allowedUrl.test(url) || !URL.canParse(url))
    throw new UndeliveredMessage("gone", "an HTTP mailbox is at an https url, or an http url of this machine");
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: ciphertext,
      // A redirect would take the bytes to a url that the mailbox does not
      // name, and that need not be one a mailbox may name. A browser does
      // not tell it from no answer, so it rejects as one.
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    throw new UndeliveredMessage("later", "the mailbox's server did not answer", { cause: error });
  }
  await response.body?.cancel();
  if (!response.ok)
    throw new UndeliveredMessage(kindOf(response.status), `the mailbox's server answered ${response.status}`);
}

function kindOf(status: number): UndeliveredMessage["kind"] {
  if (status === 404 || status === 410) return "gone";
  if (status === 408 || status === 429 || status >= 500) return "later";
  return "refused";
}
