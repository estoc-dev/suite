import type { ListData } from "@estoc/explorer";
import type { Link } from "@estoc/object";
import { createMemo, For, Show } from "solid-js";
import { isShownLastFirst, readListPage, readRowSchema, type Source } from "./list-page.ts";
import { fragmentOf, type ListPlace } from "./place.ts";
import { quantityOf } from "./text.ts";
import { linkView, valueView } from "./value-view.tsx";

export function ListView(props: {
  source: Source;
  list: ListData;
  prefix: readonly Link<unknown>[];
  from: number | undefined;
}) {
  const rowSchema = createMemo(() => readRowSchema(props.source, props.list.rows.link));
  const page = createMemo(() => readListPage(props.source, props.list, rowSchema(), props.prefix, props.from));
  const placeAt = (from: number | undefined): ListPlace | undefined =>
    from === undefined ? undefined : { list: props.list.name, prefix: props.prefix, from };
  return (
    <>
      <h1>{props.list.name}</h1>
      <p class="note">
        {isShownLastFirst(props.list)
          ? "Sorted by no field. The last rows are shown first."
          : `Sorted by ${props.list.order.join(", ")}.`}{" "}
        {props.list.readsBlobs
          ? "Read from every blob the store holds, so a row may come of an object that a stranger sent."
          : "Read from the records of the store."}
      </p>
      <Show when={props.prefix.length > 0}>
        <p class="note under">
          The rows that hold
          <For each={props.prefix}>
            {(link, at) => (
              <>
                {" "}
                {linkView(link)} in <span class="mono name">{props.list.order[at()]}</span>
              </>
            )}
          </For>
          .
        </p>
      </Show>
      <section class="card">
        <Show when={page().rows.length > 0} fallback={<p class="note">The page has no rows.</p>}>
          <table>
            <thead>
              <tr>
                <For each={page().columns}>{(column) => <th data-type={column.field.type}>{column.name}</th>}</For>
              </tr>
            </thead>
            <tbody>
              <For each={page().rows}>
                {(row) => (
                  <tr>
                    <For each={page().columns}>
                      {(column, index) => <td data-type={column.field.type}>{valueView(row[index()])}</td>}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </section>
      <nav class="turns">
        <Show when={placeAt(page().previous)}>
          {(place) => (
            <a class="link" href={fragmentOf(place())}>
              Previous
            </a>
          )}
        </Show>
        <span class="muted">
          <Show when={page().rows.length > 0} fallback={quantityOf(page().rowCount, "row", "rows")}>
            Rows {page().start + 1} to {page().start + page().rows.length} of {page().rowCount.toLocaleString("en")}
          </Show>
        </span>
        <Show when={placeAt(page().next)}>
          {(place) => (
            <a class="link" href={fragmentOf(place())}>
              Next
            </a>
          )}
        </Show>
      </nav>
    </>
  );
}
