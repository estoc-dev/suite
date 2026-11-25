import { createMemo, createSignal, Errored, For, isPending, Loading, Match, onSettled, Switch } from "solid-js";
import type { ActionSource } from "./action-page.ts";
import { ActionSessions } from "./action-sessions.ts";
import { ActionView } from "./action-view.tsx";
import { ActionsView } from "./actions-view.tsx";
import { BlobView } from "./blob-view.tsx";
import type { LinkSource } from "./link-page.ts";
import { LinksView } from "./links-view.tsx";
import type { Source } from "./list-page.ts";
import { ListView } from "./list-view.tsx";
import { actionsPlace, fragmentOf, placeIn } from "./place.ts";
import { messageOf } from "./text.ts";

const failureView = (error: () => unknown) => (
  <p class="problem" role="alert">
    {messageOf(error())}
  </p>
);

function PlaceReadiness(props: { onReady: () => void }): null {
  onSettled(() => props.onReady());
  return null;
}

export function App(props: { source: Source & ActionSource & LinkSource }) {
  const sessions = new ActionSessions(props.source);
  const fill = (fragment: string) => {
    const place = placeIn(fragment);
    // The form reads the actions as well, and shows why a read of them failed.
    if (place !== undefined && "action" in place) sessions.fill(place).catch(() => {});
  };
  fill(location.hash);
  const [fragment, setFragment] = createSignal(location.hash);
  let showFirstPlace = () => {};
  const firstPlace = new Promise<void>((resolve) => {
    showFirstPlace = resolve;
  });
  onSettled(() => {
    // The browser applies the scroll of an entry of its history once the promise of the handler
    // resolves, so the place has to be in the document by then, with its height. The page settles
    // when a place is read and shown, but before the first one it settles on the fallback: inside
    // `Loading`, `PlaceReadiness` is held back until that place is shown.
    const show = (event: NavigateEvent) => {
      // Not `hashChange`, which is false of a navigation to the address the page is already at.
      if (!event.destination.sameDocument) return;
      event.intercept({
        handler: async () => {
          const { hash } = new URL(event.destination.url);
          if (event.navigationType !== "traverse") fill(hash);
          setFragment(hash);
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
  const linksPlace = createMemo(() => {
    const shown = place();
    return shown !== undefined && ("objectsOf" in shown || "sourcesOf" in shown) ? shown : undefined;
  });
  const shownAction = createMemo(() => {
    const shown = place();
    return shown !== undefined && "action" in shown ? shown.action : undefined;
  });
  // The first list of the runtime is shown while the fragment names no place.
  const shownList = createMemo(() => {
    if (place() === undefined) return lists()[0];
    const name = listPlace()?.list;
    return lists().find((list) => list.name === name);
  });
  return (
    <Loading
      fallback={
        <main>
          <p class="note">Reading the store.</p>
        </main>
      }
    >
      <PlaceReadiness onReady={showFirstPlace} />
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
            <a
              class="link"
              href={fragmentOf(actionsPlace)}
              aria-current={place() === actionsPlace ? "page" : undefined}
            >
              Actions
            </a>
          </nav>
        </header>
        <main class={{ pending: isPending(() => place()) }}>
          <Errored fallback={failureView}>
            <Switch fallback={<p class="note">The runtime gives no list of that name.</p>}>
              <Match when={shownBlob()}>
                {(blob) => <BlobView source={props.source} sessions={sessions} link={blob()} />}
              </Match>
              <Match when={shownAction()}>{(action) => <ActionView sessions={sessions} action={action()} />}</Match>
              <Match when={place() === actionsPlace}>
                <ActionsView sessions={sessions} />
              </Match>
              <Match when={linksPlace()}>{(place) => <LinksView source={props.source} place={place()} />}</Match>
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
