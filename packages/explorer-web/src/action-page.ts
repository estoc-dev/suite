import type { Client } from "@estoc/explorer";
import {
  encodeObject,
  isLink,
  isValueMap,
  type Link,
  LinkValue,
  linkOf,
  memberOf,
  type Reader,
  type Schema,
  type Value,
} from "@estoc/object";
import type { Field } from "@estoc/schema";
import { type BlobPage, readBlobPage } from "./blob-page.ts";
import { readSchema } from "./schema.ts";
import { typeNameOf } from "./text.ts";

export type ActionSource = Pick<Client, "get" | "actions" | "perform">;

export interface TitledSchema {
  readonly link: Link<Schema>;
  readonly title: string;
}

/** `target` is the schema that each link of the field is to an object of, where the action says one. */
export interface FormField {
  readonly name: string;
  readonly field: Field;
  readonly target?: TitledSchema;
}

/** `title` is the one the request schema gave itself, and an action has no other name. */
export interface ActionForm {
  readonly title: string;
  readonly request: Schema;
  readonly result: TitledSchema;
  readonly fields: readonly FormField[];
}

export async function readActionForms(source: ActionSource): Promise<ActionForm[]> {
  const titledSchema = async (link: Link<Schema>): Promise<TitledSchema> => ({
    link,
    title: (await readSchema(source, link)).document.title,
  });
  return Promise.all(
    (await source.actions()).map(async ({ data }) => {
      const { schema, document } = await readSchema(source, data.request.link);
      const targetOf = (name: string) =>
        isValueMap(data.targetSchemas) ? memberOf(data.targetSchemas, name) : undefined;
      return {
        title: document.title,
        request: schema,
        result: await titledSchema(data.result.link),
        fields: await Promise.all(
          Object.entries(document.fields).map(async ([name, field]) => {
            const target = targetOf(name);
            return target instanceof LinkValue
              ? { name, field, target: await titledSchema(target.link as Link<Schema>) }
              : { name, field };
          }),
        ),
      };
    }),
  );
}

/** What a field is filled in with: a line of text, a link, or links with white space between them. */
export type Entry = "text" | "link" | "links";

export function entryOf(field: Field): Entry | undefined {
  if (field.type === "string") return "text";
  if (field.type === "link") return "link";
  if (field.type === "array" && field.items.type === "link") return "links";
  return undefined;
}

function linkIn(text: string, name: string): LinkValue<unknown> {
  if (!isLink(text)) throw new Error(`the field ${name} takes a link, which ${JSON.stringify(text)} is not`);
  return new LinkValue(text);
}

/**
 * Gives the bytes of a request. `texts` holds what was typed for a field under its name. An
 * optional field is left out of the request where nothing is typed for it, and where the page has
 * no input for its type.
 */
export function requestOf(form: ActionForm, texts: ReadonlyMap<string, string>): Uint8Array {
  const data: { [name: string]: Value } = {};
  for (const { name, field } of form.fields) {
    const entry = entryOf(field);
    const text = texts.get(name) ?? "";
    const isLeftEmpty = entry === undefined || text.trim() === "";
    if (isLeftEmpty && field.optional === true) continue;
    if (entry === undefined) throw new Error(`the page has no input for the field ${name}, ${typeNameOf(field)}`);
    if (entry === "text") data[name] = text;
    else if (entry === "link") data[name] = linkIn(text.trim(), name);
    else
      data[name] = isLeftEmpty
        ? []
        : text
            .trim()
            .split(/\s+/)
            .map((part) => linkIn(part, name));
  }
  return encodeObject(form.request, data).bytes;
}

/** The result is not in the store, so its page is read from the bytes the runtime gave. */
export type Outcome =
  | { readonly kind: "performed"; readonly result: BlobPage; readonly commits: readonly Link<unknown>[] }
  | { readonly kind: "failed"; readonly error: unknown };

export async function performForm(
  source: ActionSource,
  form: ActionForm,
  texts: ReadonlyMap<string, string>,
): Promise<Outcome> {
  try {
    const { result, commits } = await source.perform(requestOf(form, texts));
    const link = linkOf(result);
    const reader: Reader = { get: async (asked) => (asked === link ? result : source.get(asked)) };
    return { kind: "performed", result: await readBlobPage(reader, link), commits };
  } catch (error) {
    return { kind: "failed", error };
  }
}
