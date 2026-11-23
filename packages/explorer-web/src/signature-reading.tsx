import { ed25519, eip191, loadIdentity, type Signature, solanaOffchain } from "@estoc/identity";
import { Implementations } from "@estoc/object";
import type { ReadingAs } from "./reading.ts";
import { linkView } from "./value-view.tsx";

const schemes = [ed25519, eip191, solanaOffchain];

const honoredBy =
  "Honored by the identity version it carries and those that version follows alone. The page looks at no others to verify it, a later crisis that the store holds among them.";

export const signatureReading: ReadingAs<Signature> = {
  name: "a signature",
  implementations: new Implementations([loadIdentity(schemes).signatures.implementation]),
  viewOf: ({ signedIdentity, key, object }) => (
    <>
      <dl class="head">
        <dt>Identifier</dt>
        <dd>{linkView(signedIdentity.identity.identifier)}</dd>
        <dt>Key</dt>
        <dd>{linkView(key.link)}</dd>
        <dt>Object</dt>
        <dd>{linkView(object)}</dd>
      </dl>
      <p class="note">{honoredBy}</p>
    </>
  ),
};
