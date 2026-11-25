import type { JSX } from "@solidjs/web";
import type { LinksUnder } from "./pair-rows.ts";
import { fragmentOf, type ListPlace } from "./place.ts";

/** Where more rows are under the link than are shown, leads to all of them at `place`. */
export function remainingRowsView({ links, rowCount }: LinksUnder, place: ListPlace): JSX.Element {
  return (
    rowCount > links.length && (
      <p class="note remaining">
        The first {links.length} of{" "}
        <a class="link" href={fragmentOf(place)}>
          {rowCount.toLocaleString("en")} rows
        </a>
        .
      </p>
    )
  );
}
