import { createMemo, createSignal, Errored, For, Loading, Match, onSettled, Switch } from "solid-js";
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

export function App(props: { source: Source }) {
  const [fragment, setFragment] = createSignal(location.hash);
  onSettled(() => {
    // The browser restores the scroll of an entry of its history that the page has shown, and gives
    // a new entry the scroll of the one before it. The state marks an entry as shown, so that a new
    // one starts at its top.
    const read = () => {
      setFragment(location.hash);
      if (history.state !== null) return;
      history.replaceState(true, "");
      scrollTo(0, 0);
    };
    read();
    addEventListener("hashchange", read);
    return () => removeEventListener("hashchange", read);
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
    <Errored fallback={failureView}>
      <Loading>
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
        <main>
          <Errored fallback={failureView}>
            <Switch fallback={<p class="note">The runtime gives no list of that name.</p>}>
              <Match when={shownBlob()}>{(blob) => <BlobView reader={props.source} link={blob()} />}</Match>
              <Match when={shownList()}>
                {(list) => <ListView source={props.source} list={list()} from={listPlace()?.from} />}
              </Match>
            </Switch>
          </Errored>
        </main>
      </Loading>
    </Errored>
  );
}
