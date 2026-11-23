/**
 * `from` counts the rows of the list before where the page begins. The page goes on from there in
 * the order the list is shown: towards the end of a list shown in its own order, and towards the
 * front of one shown newest first. Left out, the page begins where the list as shown begins.
 */
export interface Place {
  readonly list: string;
  readonly from?: number;
}

export function fragmentOf({ list, from }: Place): string {
  return `#${new URLSearchParams({ list, ...(from === undefined ? {} : { from: String(from) }) })}`;
}

function countIn(text: string | null): number | undefined {
  const count = text !== null && /^\d+$/.test(text) ? Number(text) : undefined;
  return Number.isSafeInteger(count) ? count : undefined;
}

export function placeIn(fragment: string): Place | undefined {
  const parameters = new URLSearchParams(fragment.slice(1));
  const list = parameters.get("list");
  if (list === null) return undefined;
  const from = countIn(parameters.get("from"));
  return from === undefined ? { list } : { list, from };
}
