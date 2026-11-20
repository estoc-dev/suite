import { ed25519, eip191, loadIdentity, type Signature, solanaOffchain } from "@estoc/identity";
import { Implementations } from "@estoc/object";
import { type Child, h } from "./dom.ts";
import { linkView } from "./link-view.ts";
import type { ReadingAs } from "./reading.ts";

const schemes = [ed25519, eip191, solanaOffchain];

// The page verifies each signature by itself. It gathers no identity versions, from the file or from
// one file to the next, so a signature it shows as read is honored by those it carries alone, where
// the same file can hold a crisis that came after them. The links it shows do not say that, so the
// view says it.
const honoredBy =
  "Honored by the identity version it carries and those that version follows alone. The page looks at no others to verify it, a later crisis in the same file among them.";

function signatureView({ signedIdentity, key, object }: Signature): Child {
  return [
    h(
      "dl",
      { class: "head" },
      h("dt", null, "Identifier"),
      h("dd", null, linkView(signedIdentity.identity.identifier)),
      h("dt", null, "Key"),
      h("dd", null, linkView(key.link)),
      h("dt", null, "Object"),
      h("dd", null, linkView(object)),
    ),
    h("p", { class: "note" }, honoredBy),
  ];
}

export const signatureReading: ReadingAs<Signature> = {
  name: "a signature",
  implementations: () => new Implementations([loadIdentity(schemes).signatures.implementation]),
  viewOf: signatureView,
};
