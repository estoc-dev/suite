import { isLink, type Link, type Schema } from "@estoc/object";

/**
 * - `prefix` holds links for the first of the fields the list is sorted by, in their order, and the
 *   place is of the rows under them. Left out, it is of every row of the list.
 * - `from` counts the rows of the place before where the page begins. The page goes on from there
 *   in the order the list is shown: towards the end of a list shown in its own order, and towards
 *   the front of one shown last row first. Left out, the page begins where the list as shown begins.
 */
export interface ListPlace {
  readonly list: string;
  readonly prefix?: readonly Link<unknown>[];
  readonly from?: number;
}

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
 * - Each time a place with `filledField` is shown, that field of the form is set to the link, over
 *   what was typed for it.
 */
export interface ActionPlace {
  readonly action: Link<Schema>;
  readonly filledField?: FilledField;
}

export type Place = ListPlace | BlobPlace | typeof actionsPlace | ActionPlace;

export function fragmentOf(place: Place): string {
  if ("blob" in place) return `#${place.blob}`;
  if ("actions" in place) return "#actions";
  if ("action" in place) {
    const { action, filledField } = place;
    const filling = filledField === undefined ? {} : { field: filledField.name, link: filledField.link };
    return `#${new URLSearchParams({ action, ...filling })}`;
  }
  const { list, prefix = [], from } = place;
  return `#${new URLSearchParams([
    ["list", list],
    ...prefix.map((link) => ["prefix", link]),
    ...(from === undefined ? [] : [["from", String(from)]]),
  ])}`;
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
  const list = parameters.get("list");
  const prefix = parameters.getAll("prefix");
  if (list === null || !prefix.every(isLink)) return undefined;
  const from = countIn(parameters.get("from"));
  return { list, ...(prefix.length > 0 && { prefix }), ...(from !== undefined && { from }) };
}
