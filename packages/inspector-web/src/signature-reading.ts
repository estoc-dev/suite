import {
  ed25519,
  eip191,
  loadIdentity,
  noIdentityVersions,
  type Signature,
  type SignatureData,
  solanaOffchain,
} from "@estoc/identity";
import { type Implementation, Implementations } from "@estoc/object";
import { type Child, h } from "./dom.ts";
import { linkView } from "./link-view.ts";
import type { ReadingAs } from "./reading.ts";

const { signatures } = loadIdentity([ed25519, eip191, solanaOffchain]);

// The page keeps no identity versions from one file to the next, so it has seen none but those a
// signature carries. A signature it shows as read is honored by those alone, which the links it
// shows do not say, so the view says it.
const verifiedSignature: Implementation<Signature, SignatureData> = {
  schema: signatures.schema,
  read: (signature, reader) => signatures.verify(signature, reader, noIdentityVersions),
};
const honoredBy =
  "Honored by the identity version it carries and those that version follows alone. The page has seen no others, so it does not know of a crisis that came after them.";

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
  implementations: new Implementations([verifiedSignature]),
  viewOf: signatureView,
};
