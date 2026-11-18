// @vitest-environment happy-dom
import { ed25519, loadIdentity, SoftwareSigner } from "@estoc/identity";
import { linkOf } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { fragmentOf } from "../src/address.ts";
import { h } from "../src/dom.ts";
import { signatureReading } from "../src/signature-reading.ts";

const { keys, publish, signatures } = loadIdentity([ed25519]);
const root = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const agent = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2));
const signedIdentity = await publish(root, { agents: [agent.key], at: 1763078400000 });
const photo = { link: linkOf(Uint8Array.of(0, 10, 255)) };
const signature = await signatures.actor(agent, signedIdentity).sign(photo);

describe("the view of a signature", () => {
  const view = h("div", null, signatureReading.viewOf(signature));

  it("names who signed, the key that signed and the object, each as a link to follow", () => {
    expect(Array.from(view.querySelectorAll("dt"), (node) => node.textContent)).toEqual([
      "Identifier",
      "Key",
      "Object",
    ]);
    expect(Array.from(view.querySelectorAll("dd a"), (node) => node.getAttribute("href"))).toEqual(
      [keys.encode(root.key).link, keys.encode(agent.key).link, photo.link].map(fragmentOf),
    );
  });

  it("says which identity versions it is honored by", () => {
    expect(view.querySelector(".note")?.textContent).toBe(
      "Honored by the identity version it carries and those that version follows alone. The page has seen no others, so it does not know of a crisis that came after them.",
    );
  });
});
