import type { ListData } from "@estoc/explorer";
import { createMemo, For, isPending, Loading, Show } from "solid-js";
import { isShownNewestFirst, readListPage, readRowSchema, type Source } from "./list-page.ts";
import { fragmentOf } from "./place.ts";
import { quantityOf } from "./text.ts";
import { valueView } from "./value-view.tsx";

export function ListView(props: { source: Source; list: ListData; from: number | undefined }) {
  const rowSchema = createMemo(() => readRowSchema(props.source, props.list.rows.link));
  const page = createMemo(() => readListPage(props.source, props.list, rowSchema(), props.from));
  return (
    <>
      <h1>{props.list.name}</h1>
      <p class="note">
        {isShownNewestFirst(props.list)
          ? "In the order written, newest first."
          : `Sorted by ${props.list.order.join(", ")}.`}{" "}
        {props.list.readsBlobs
          ? "Read from every blob the store holds, so a row may come of an object that a stranger sent."
          : "Read from the records of the store."}
      </p>
      <Loading fallback={<p class="note">Reading the list.</p>}>
        <section class={["card", { pending: isPending(() => page()) }]}>
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
                        {(column) => <td data-type={column.field.type}>{valueView(row[column.name])}</td>}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </section>
        <nav class="turns">
          <Show when={page().previous}>
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
          <Show when={page().next}>
            {(place) => (
              <a class="link" href={fragmentOf(place())}>
                Next
              </a>
            )}
          </Show>
        </nav>
      </Loading>
    </>
  );
}
