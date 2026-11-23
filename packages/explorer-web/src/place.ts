/**
 * `from` counts the rows of the list before where the page starts to read, and is left out for
 * where the list itself starts.
 */
export interface Place {
  readonly list: string;
  readonly from?: number;
}

export function fragmentOf({ list, from }: Place): string {
  return `#${new URLSearchParams({ list, ...(from === undefined ? {} : { from: String(from) }) })}`;
}

export function placeIn(fragment: string): Place | undefined {
  const parameters = new URLSearchParams(fragment.slice(1));
  const list = parameters.get("list");
  if (list === null) return undefined;
  const from = Number(parameters.get("from") ?? Number.NaN);
  return Number.isSafeInteger(from) && from >= 0 ? { list, from } : { list };
}
