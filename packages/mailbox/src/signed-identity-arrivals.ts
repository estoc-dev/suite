import { signedIdentitySchema } from "@estoc/identity";
import { arrivalsView } from "@estoc/store";

export const signedIdentityArrivalsView = arrivalsView(signedIdentitySchema);
