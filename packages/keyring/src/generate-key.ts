import { identityKit } from "@estoc/identity";
import { LinkValue } from "@estoc/object";
import { link, schema, string } from "@estoc/schema";
import { actionOver } from "@estoc/store";
import { Keyring } from "./keyring.ts";

const { secretKeys } = identityKit;

export const generateKey = actionOver(
  schema("Generate Key", { scheme: string() }),
  schema("Generated Key", { key: link() }),
  async ({ scheme: name }, store) => {
    const scheme = secretKeys.schemeNamed(name);
    if (scheme === undefined) throw new Error(`${name} is not the name of a scheme a curve signs in`);
    const key = await new Keyring(store, secretKeys).generate(scheme);
    return { key: new LinkValue(key.link) };
  },
);
