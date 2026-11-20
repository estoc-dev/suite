import { type DataOf, schema, string } from "@estoc/schema";
import { type Route, type Transport, UndeliveredMessage } from "./mailbox.ts";

// Plain http is for the receiver's own machine alone, as in development or
// for a daemon beside the sender. Anywhere else, whoever is on the way would
// see when and how much arrives, and could hold messages back unseen.
const allowedUrl = /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?([/?#]|$))/;

const transportSchema = schema("HTTP transport", { url: string() });

const post: RequestInit = {
  method: "POST",
  headers: { "content-type": "application/octet-stream" },
  // A redirect would take the bytes to a url that the mailbox does not
  // name, and that need not be one a mailbox may name. A browser does
  // not tell it from no answer, so it rejects as one.
  redirect: "error",
  credentials: "omit",
  referrerPolicy: "no-referrer",
};

/**
 * The body goes as `application/octet-stream`, so a server that browsers post to answers their CORS
 * preflight for it.
 */
export const httpTransport: Transport<DataOf<typeof transportSchema>> = { schema: transportSchema, routeTo };

function routeTo({ url }: DataOf<typeof transportSchema>): Route {
  if (!allowedUrl.test(url) || !fetchAccepts(url))
    throw new UndeliveredMessage("gone", "an HTTP transport names an https url, or an http url of this machine");
  return { deliver: (ciphertext) => deliverTo(url, ciphertext) };
}

// Fetch refuses some urls that parse, as one with a user name, so such a url
// is turned back as gone with the route rather than at each send as one to
// send later. The request made here is not kept for the sends, since fetch
// resets the referrer policy of a request it is given with options.
function fetchAccepts(url: string): boolean {
  try {
    new Request(url, post);
    return true;
  } catch {
    return false;
  }
}

async function deliverTo(url: string, ciphertext: Uint8Array): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { ...post, body: ciphertext });
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
