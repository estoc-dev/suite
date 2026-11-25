import { createMemo, For, Show } from "solid-js";
import { type ActionSource, readActionForms } from "./action-page.ts";
import { fragmentOf } from "./place.ts";

export function ActionsView(props: { source: ActionSource }) {
  const forms = createMemo(() => readActionForms(props.source));
  return (
    <>
      <h1>Actions</h1>
      <p class="note">
        Performed by the runtime on its store. The runtime writes neither a request nor its result to the store.
      </p>
      <section class="card">
        <Show when={forms().length > 0} fallback={<p class="note">The runtime lists no action.</p>}>
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Takes</th>
                <th>Gives</th>
              </tr>
            </thead>
            <tbody>
              <For each={forms()}>
                {(form) => (
                  <tr>
                    <td>
                      <a class="link" href={fragmentOf({ action: form.request.link })}>
                        {form.title}
                      </a>
                    </td>
                    <td class="mono">{form.fields.map(({ name }) => name).join(", ")}</td>
                    <td>{form.result.title}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </section>
    </>
  );
}
