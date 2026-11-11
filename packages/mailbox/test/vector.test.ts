import { linkOf } from "@estoc/object";
import { hex } from "@scure/base";
import { expect, test } from "vitest";
import { MailboxKey } from "../src/index.ts";

// The ciphertext was made by the HPKE of Python's cryptography package, with
// a random ephemeral key, for the secret key of 32 bytes of 1, over a zip that
// Python's zipfile wrote without compression; another info, KEM, KDF or AEAD
// does not open it. The link of the root was checked against its hashlib.
const rootText =
  '{"$schema":{"$link":"sha256:4befaefd858ba9162269f196b9a506074db59a7003b7f5dcad204cd6727beaf4"},' + '"text":"hello"}';
const rootLink = "sha256:3ef9c24d1e5d91d4626986ba5d455a77b35b24e8f28db90563b1f007e4ce92a8";
const blob = new Uint8Array([0xfb, 0xff, 0xbf]);
const ciphertext =
  "5e9894733f06960658af22533fa03427a135e5738b6bd5ea7417532e367ddf4751728e4afc7348a2b1103f109b8263ec4679d49cc50fca170baf331bacfef0dc" +
  "2ab66ee70633eb4bbb2387c79c021b1a249824ed14bfa389841ece27faace7a1efb8e31f2e54191e90404a5b5971fc0c46265506707c0a9a93b0f4944e7cdb31" +
  "df096295fbb16a4a40c2acd4adb48bf3efb9bf0399a3556f3c74022a4ea5cd8b35840f85feb4dbbe677782e61143a7138643e4802a3ef2441e29d7318ed97541" +
  "af0eab28ea821822a2f4dae889ce069d6aaf92f9c066eb245f3293f67a30952097a472529545ce45f933c2f698662dbe8848a0d111a81554f254c25595125297" +
  "665d24a764276480f6c524539b37cac58139c00c914a44f308afd4948898db82f022f14305c163b953271c44447848b4b1e7ee785b99d9916cd1ac5f58fd96fe" +
  "29b6e6b4a7c824d85f1bc8426da12e6c270d77a89b7c267fce41e1eff13e12a2a29ad22343bf34f554fdc5d654067ec2adf523709a17ed534e7d18654108a7ed" +
  "d763ab22173a98dd6544b6315d68cd689eb7d6583d032bca4875d1a0d36a2e95006df8820580958bb77fd1eb817729f375493d1a19c2a46d5c2da140ec92b95c" +
  "3d3d10289442c602b348419d5977a1d17f5f66e5f9f6a7f64966f186bb755979cbd57d7248f9dd455112e133a4eb4d1319e6896307fcb2c21de2e46fbd";

const key = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(1));

test("a ciphertext made elsewhere opens with that key to a bundle of a root and a blob", async () => {
  const bundle = await key.open(hex.decode(ciphertext));
  expect(new TextDecoder().decode(bundle.root)).toBe(rootText);
  expect(bundle.link).toBe(rootLink);
  expect(bundle.get(linkOf(blob))).toEqual(blob);
});
