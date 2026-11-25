import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { type LinkSource, readLinkSetPage } from "./link-page.ts";
import { fragmentOf, type LinkSet, type LinksPlace } from "./place.ts";
import { quantityOf } from "./text.ts";
import { linkView } from "./value-view.tsx";

/** Where the set has more links than `links`, leads to the page of all of them. */
export function remainingLinksView(
  { links, linkCount }: { readonly links: readonly unknown[]; readonly linkCount: number },
  set: LinkSet,
): JSX.Element {
  return (
    linkCount > links.length && (
      <p class="note remaining">
        The first {links.length} of{" "}
        <a class="link" href={fragmentOf(set)}>
          {quantityOf(linkCount, "object", "objects")}
        </a>
        .
      </p>
    )
  );
}

export function LinksView(props: { source: LinkSource; place: LinksPlace }) {
  const page = createMemo(() => readLinkSetPage(props.source, props.place, props.place.from));
  const placeAt = (from: number | undefined): LinksPlace | undefined =>
    from === undefined ? undefined : { ...props.place, from };
  return (
    <>
      <h1>{"objectsOf" in props.place ? "Objects" : "Linked from"}</h1>
      <p class="note">
        {"objectsOf" in props.place ? (
          <>The objects the store holds that are written to {linkView(props.place.objectsOf)}.</>
        ) : (
          <>The objects the store holds that link to {linkView(props.place.sourcesOf)}.</>
        )}{" "}
        Read from every blob the store holds, so one may be an object that a stranger sent.
      </p>
      <section class="card">
        <Show when={page().links.length > 0} fallback={<p class="note">The page has no objects.</p>}>
          <ul class="items sources">
            <For each={page().links}>{(link) => <li>{linkView(link)}</li>}</For>
          </ul>
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
          <Show when={page().links.length > 0} fallback={quantityOf(page().linkCount, "object", "objects")}>
            Objects {page().start + 1} to {page().start + page().links.length} of{" "}
            {page().linkCount.toLocaleString("en")}
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
