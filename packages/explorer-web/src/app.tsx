import { createMemo, createSignal, Errored, For, isPending, Loading, Match, onSettled, Switch } from "solid-js";
import { BlobView } from "./blob-view.tsx";
import type { Source } from "./list-page.ts";
import { ListView } from "./list-view.tsx";
import { fragmentOf, placeIn } from "./place.ts";
import { messageOf } from "./text.ts";

const failureView = (error: () => unknown) => (
  <p class="problem" role="alert">
    {messageOf(error())}
  </p>
);

/** Settles once what is beside it is shown: the `Loading` above holds it back while that shows its fallback. */
function Shown(props: { onShown: () => void }): null {
  onSettled(() => props.onShown());
  return null;
}

export function App(props: { source: Source }) {
  const [fragment, setFragment] = createSignal(location.hash);
  let showFirstPlace = () => {};
  const firstPlace = new Promise<void>((resolve) => {
    showFirstPlace = resolve;
  });
  onSettled(() => {
    // The browser keeps the scroll of each entry of its history and applies it once the promise of
    // the handler resolves: an entry gone back to gets the scroll it was left at, and a new one
    // starts at its top. The place has to be in the document by then, with its height. The views
    // have no `Loading` of their own, so the page settles only when the place is read and shown.
    // Before the first place is read it settles on the fallback, so the promise awaits that place too.
    const show = (event: NavigateEvent) => {
      // Not `hashChange`, which is false of a navigation to the address the page is already at.
      if (!event.destination.sameDocument) return;
      event.intercept({
        handler: async () => {
          setFragment(new URL(event.destination.url).hash);
          await new Promise<void>((resolve) => onSettled(() => resolve()));
          await firstPlace;
        },
      });
    };
    navigation.addEventListener("navigate", show);
    return () => navigation.removeEventListener("navigate", show);
  });
  const place = createMemo(() => placeIn(fragment()));
  const lists = createMemo(async () => (await props.source.lists()).map(({ data }) => data));
  const shownBlob = createMemo(() => {
    const shown = place();
    return shown !== undefined && "blob" in shown ? shown.blob : undefined;
  });
  const listPlace = createMemo(() => {
    const shown = place();
    return shown !== undefined && "list" in shown ? shown : undefined;
  });
  // The first list of the runtime is shown while the fragment names no place.
  const shownList = createMemo(() => {
    if (shownBlob() !== undefined) return undefined;
    const name = listPlace()?.list;
    return name === undefined ? lists()[0] : lists().find((list) => list.name === name);
  });
  return (
    <Loading
      fallback={
        <main>
          <p class="note">Reading the store.</p>
        </main>
      }
    >
      <Shown onShown={showFirstPlace} />
      <Errored fallback={failureView}>
        <header>
          <span class="brand">Explorer</span>
          <nav>
            <For each={lists()}>
              {(list) => (
                <a
                  class="link"
                  href={fragmentOf({ list: list.name })}
                  aria-current={list === shownList() ? "page" : undefined}
                >
                  {list.name}
                </a>
              )}
            </For>
          </nav>
        </header>
        <main class={{ pending: isPending(() => place()) }}>
          <Errored fallback={failureView}>
            <Switch fallback={<p class="note">The runtime gives no list of that name.</p>}>
              <Match when={shownBlob()}>{(blob) => <BlobView reader={props.source} link={blob()} />}</Match>
              <Match when={shownList()}>
                {(list) => <ListView source={props.source} list={list()} from={listPlace()?.from} />}
              </Match>
            </Switch>
          </Errored>
        </main>
      </Errored>
    </Loading>
  );
}
