import type { Client } from "@estoc/explorer";
import {
  encodeObject,
  isLink,
  isValueMap,
  type Link,
  LinkValue,
  linkOf,
  memberOf,
  type Schema,
  type Value,
} from "@estoc/object";
import type { Field } from "@estoc/schema";
import { type BlobPage, readBlobPage } from "./blob-page.ts";
import { readSchema } from "./schema.ts";
import { typeNameOf } from "./text.ts";

export type ActionSource = Pick<Client, "get" | "objectsOf" | "actions" | "perform">;

export interface TitledSchema {
  readonly schema: Schema;
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
  const readTitledSchema = async (link: Link<Schema>): Promise<TitledSchema> => {
    const { schema, document } = await readSchema(source, link);
    return { schema, title: document.title };
  };
  return Promise.all(
    (await source.actions()).map(async ({ data }) => {
      const { schema, document } = await readSchema(source, data.request.link);
      const targetOf = (name: string) =>
        isValueMap(data.targetSchemas) ? memberOf(data.targetSchemas, name) : undefined;
      return {
        title: document.title,
        request: schema,
        result: await readTitledSchema(data.result.link),
        fields: await Promise.all(
          Object.entries(document.fields).map(async ([name, field]) => {
            const target = targetOf(name);
            return target instanceof LinkValue
              ? { name, field, target: await readTitledSchema(target.link as Link<Schema>) }
              : { name, field };
          }),
        ),
      };
    }),
  );
}

export interface TakingField {
  readonly form: ActionForm;
  readonly field: FormField;
}

/** The fields that take links to objects written to `schema`, in the order of the forms. */
export function fieldsTaking(forms: readonly ActionForm[], schema: Link<unknown>): TakingField[] {
  return forms.flatMap((form) =>
    form.fields.filter(({ target }) => target?.schema.link === schema).map((field) => ({ form, field })),
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

function valueIn(text: string, { name, field }: FormField): Value | undefined {
  const entry = entryOf(field);
  const isLeftEmpty = entry === undefined || text.trim() === "";
  if (isLeftEmpty && field.optional === true) return undefined;
  if (entry === undefined) throw new Error(`the page has no input for the field ${name}, ${typeNameOf(field)}`);
  if (entry === "text") return text;
  if (entry === "link") return linkIn(text.trim(), name);
  return isLeftEmpty
    ? []
    : text
        .trim()
        .split(/\s+/)
        .map((part) => linkIn(part, name));
}

/**
 * `texts` holds what was typed for a field under its name. An optional field is left out of the
 * request where nothing is typed for it, and where the page has no input for its type.
 */
export function requestOf(form: ActionForm, texts: ReadonlyMap<string, string>): Uint8Array {
  // Assigning each member to an object would leave out a field named `__proto__`.
  const data = Object.fromEntries(
    form.fields.flatMap((field): [string, Value][] => {
      const value = valueIn(texts.get(field.name) ?? "", field);
      return value === undefined ? [] : [[field.name, value]];
    }),
  );
  return encodeObject(form.request, data).bytes;
}

/**
 * A result is written to the result schema of its action, which the form holds, so what the result
 * holds is shown from the bytes of the reply with no read of the source. What the page reads the
 * result as beyond that may read other blobs from the source.
 */
export function readResultPage(
  source: Pick<ActionSource, "get">,
  form: ActionForm,
  result: Uint8Array,
): Promise<BlobPage> {
  const held = new Map<Link<unknown>, Uint8Array>(
    [result, ...form.result.schema.blobs].map((bytes) => [linkOf(bytes), bytes]),
  );
  return readBlobPage({ get: async (link) => held.get(link) ?? source.get(link) }, linkOf(result));
}
