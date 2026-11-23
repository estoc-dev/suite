import { createMemo, createSignal, Errored, For, Loading, onSettled, Show } from "solid-js";
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
    const read = () => setFragment(location.hash);
    addEventListener("hashchange", read);
    return () => removeEventListener("hashchange", read);
  });
  const place = createMemo(() => placeIn(fragment()));
  const lists = createMemo(async () => (await props.source.lists()).map(({ data }) => data));
  const shownList = createMemo(() => {
    const name = place()?.list;
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
            <Show when={shownList()} fallback={<p class="note">The runtime gives no list of that name.</p>}>
              {(list) => <ListView source={props.source} list={list()} from={place()?.from} />}
            </Show>
          </Errored>
        </main>
      </Loading>
    </Errored>
  );
}
