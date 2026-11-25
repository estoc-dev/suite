import { isLink, type Link, type Schema } from "@estoc/object";

/**
 * `from` counts the rows of the list before where the page begins. The page goes on from there in
 * the order the list is shown: towards the end of a list shown in its own order, and towards the
 * front of one shown last row first. Left out, the page begins where the list as shown begins.
 */
export interface ListPlace {
  readonly list: string;
  readonly from?: number;
}

/** The objects held that are written to a schema, or the objects held that link to a blob. */
export type LinkSet = { readonly objectsOf: Link<Schema> } | { readonly sourcesOf: Link<unknown> };

/** `from` counts the links of the set before where the page begins, and left out it is none. */
export type LinksPlace = LinkSet & { readonly from?: number };

export interface BlobPlace {
  readonly blob: Link<unknown>;
}

export const actionsPlace = { actions: "all" } as const;

export interface FilledField {
  readonly name: string;
  readonly link: Link<unknown>;
}

/**
 * - `action` is the request schema of the action, which is what tells it from the others.
 * - Going to a place with `filledField`, by a link or by its address, sets that field of the form
 *   to the link, over what was typed for it. Going back or forward to one in the history of the
 *   browser sets nothing, so the form is as it was left.
 */
export interface ActionPlace {
  readonly action: Link<Schema>;
  readonly filledField?: FilledField;
}

export type Place = ListPlace | LinksPlace | BlobPlace | typeof actionsPlace | ActionPlace;

export function fragmentOf(place: Place): string {
  if ("blob" in place) return `#${place.blob}`;
  if ("actions" in place) return "#actions";
  if ("action" in place) {
    const { action, filledField } = place;
    const fieldParameters = filledField === undefined ? {} : { field: filledField.name, link: filledField.link };
    return `#${new URLSearchParams({ action, ...fieldParameters })}`;
  }
  const [name, value] =
    "list" in place
      ? ["list", place.list]
      : "objectsOf" in place
        ? ["objects", place.objectsOf]
        : ["sources", place.sourcesOf];
  return `#${new URLSearchParams([[name, value], ...(place.from === undefined ? [] : [["from", String(place.from)]])])}`;
}

function countIn(text: string | null): number | undefined {
  const count = text !== null && /^\d+$/.test(text) ? Number(text) : undefined;
  return Number.isSafeInteger(count) ? count : undefined;
}

export function placeIn(fragment: string): Place | undefined {
  const text = fragment.slice(1);
  if (isLink(text)) return { blob: text };
  if (text === "actions") return actionsPlace;
  const parameters = new URLSearchParams(text);
  const action = parameters.get("action");
  if (action !== null) {
    if (!isLink(action)) return undefined;
    const name = parameters.get("field");
    const link = parameters.get("link");
    return name !== null && link !== null && isLink(link) ? { action, filledField: { name, link } } : { action };
  }
  const from = countIn(parameters.get("from"));
  const start = from === undefined ? {} : { from };
  const list = parameters.get("list");
  if (list !== null) return { list, ...start };
  const schema = parameters.get("objects");
  if (schema !== null) return isLink(schema) ? { objectsOf: schema, ...start } : undefined;
  const target = parameters.get("sources");
  return target !== null && isLink(target) ? { sourcesOf: target, ...start } : undefined;
}
