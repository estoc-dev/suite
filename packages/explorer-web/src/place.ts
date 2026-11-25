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

export interface BlobPlace {
  readonly blob: Link<unknown>;
}

/** Where every action of the runtime is listed. */
export const actionsPlace = { actions: "all" } as const;

/** `action` is the request schema of the action, which is what tells it from the others. */
export interface ActionPlace {
  readonly action: Link<Schema>;
}

export type Place = ListPlace | BlobPlace | typeof actionsPlace | ActionPlace;

export function fragmentOf(place: Place): string {
  if ("blob" in place) return `#${place.blob}`;
  if ("actions" in place) return "#actions";
  if ("action" in place) return `#${new URLSearchParams({ action: place.action })}`;
  const { list, from } = place;
  return `#${new URLSearchParams({ list, ...(from === undefined ? {} : { from: String(from) }) })}`;
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
  if (action !== null) return isLink(action) ? { action } : undefined;
  const list = parameters.get("list");
  if (list === null) return undefined;
  const from = countIn(parameters.get("from"));
  return from === undefined ? { list } : { list, from };
}
