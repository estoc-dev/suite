import { type Actor, identityKit, type SignedIdentityObject } from "@estoc/identity";
import type { Link } from "@estoc/object";
import { peopleView } from "@estoc/people";
import { type Store, view } from "@estoc/store";
import { Keyring } from "./keyring.ts";

const { secretKeys, signatures, signedIdentities } = identityKit;

/**
 * The key is chosen once, among those of the identity version that is current when the actor is
 * made: its root, then its agents in the order listed. An actor whose key a later identity version
 * leaves out does not sign.
 */
export async function actorFor(signedIdentity: Link<unknown>, store: Store): Promise<Actor> {
  const inHand = await signedIdentities.read(signedIdentity, store);
  const currentOf = async (version: SignedIdentityObject) => (await view(store, peopleView)).current(version);
  const { identity, link } = await currentOf(inHand);
  const keyring = new Keyring(store, secretKeys);
  for (const key of [identity.root, ...identity.agents]) {
    const signer = await keyring.signerFor(key.link);
    if (signer !== undefined) return signatures.actor(signer, inHand, currentOf);
  }
  throw new Error(`the store records no Secret Key of a key that ${link} lists`);
}
