import { json } from "./json.ts";

/**
 * The encoding Estoc writes in, and the one read where no other is given.
 * It is the encoding of the language that `defaultValidator` reads, so the
 * two are chosen together.
 */
export const defaultEncoding = json;
