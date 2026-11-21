import type { Link } from "@estoc/object";
import { secretSchema } from "@estoc/schema";
import { namedSchemaOf } from "./scanned-blob.ts";

export function isSecret(bytes: Uint8Array): boolean {
  return namedSchemaOf(bytes) === secretSchema.link;
}

export class UnreadSecret extends Error {
  readonly link: Link<unknown>;

  constructor(link: Link<unknown>) {
    super(`${link} is a Secret, which the store does not read`);
    this.link = link;
  }
}
