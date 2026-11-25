import type { Client } from "@estoc/explorer";
import type { Link } from "@estoc/object";
import type { JSX } from "@solidjs/web";
import { createMemo, Errored, For, Loading, Show } from "solid-js";
import { fieldsTaking } from "./action-page.ts";
import type { ActionSessions } from "./action-sessions.ts";
import { type BlobPage, readBlobPage } from "./blob-page.ts";
import { shownLinkLimit } from "./link-page.ts";
import { remainingLinksView } from "./links-view.tsx";
import { objectView } from "./object-view.tsx";
import { fragmentOf } from "./place.ts";
import { hexOf, messageOf, quantityOf } from "./text.ts";
import { linkView } from "./value-view.tsx";

export function blobPageView({ inspection, reading }: BlobPage): JSX.Element {
  if (inspection.kind === "object") return objectView(inspection, reading);
  if (inspection.kind === "absent")
    return (
      <>
        <dl class="head">
          <dt>Link</dt>
          <dd class="mono">{inspection.link}</dd>
        </dl>
        <p class="note">The runtime gives no blob for it.</p>
      </>
    );
  const { bytes } = inspection;
  return (
    <>
      <dl class="head">
        <dt>Link</dt>
        <dd class="mono">{inspection.link}</dd>
        <dt>Size</dt>
        <dd>{quantityOf(bytes.length, "byte", "bytes")}</dd>
      </dl>
      <p class="note">Not an object of the Estoc Object Format: bytes, which link to nothing.</p>
      {bytes.length > 0 && <p class="mono bytes dump">{hexOf(bytes)}</p>}
    </>
  );
}

const problemView = (error: () => unknown) => <p class="problem">{messageOf(error())}</p>;

/** The actions with a field that takes the object, each leading to its form with that field filled in. */
function TakingActionsView(props: { sessions: ActionSessions; object: Link<unknown>; schema: Link<unknown> }) {
  const forms = createMemo(async () => (await props.sessions.all()).map(({ form }) => form));
  const fields = createMemo(() => fieldsTaking(forms(), props.schema));
  return (
    <Show when={fields().length > 0}>
      <h2>Actions</h2>
      <section class="card">
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th>Field</th>
            </tr>
          </thead>
          <tbody>
            <For each={fields()}>
              {({ form, field }) => (
                <tr>
                  <td>
                    <a
                      class="link"
                      href={fragmentOf({
                        action: form.request.link,
                        filledField: { name: field.name, link: props.object },
                      })}
                    >
                      {form.title}
                    </a>
                  </td>
                  <td>
                    <span class="mono name">{field.name}</span>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
    </Show>
  );
}

function LinkedFromView(props: { source: Pick<Client, "sourcesOf">; link: Link<unknown> }) {
  const sources = createMemo(() => props.source.sourcesOf(props.link, 0, shownLinkLimit));
  return (
    <Show when={sources().links.length > 0} fallback={<p class="note">Nothing the store holds links to it.</p>}>
      <ul class="items sources">
        <For each={sources().links}>{(source) => <li>{linkView(source)}</li>}</For>
      </ul>
      {remainingLinksView(sources(), { sourcesOf: props.link })}
    </Show>
  );
}

export function BlobView(props: {
  source: Pick<Client, "get" | "sourcesOf">;
  sessions: ActionSessions;
  link: Link<unknown>;
}) {
  const page = createMemo(() => readBlobPage(props.source, props.link));
  const object = createMemo(() => {
    const { inspection } = page();
    return inspection.kind === "object" ? inspection : undefined;
  });
  return (
    <>
      <h1>Blob</h1>
      <section class="card">{blobPageView(page())}</section>
      <Show when={object()}>
        {(object) => (
          <Errored fallback={problemView}>
            <Loading>
              <TakingActionsView sessions={props.sessions} object={object().link} schema={object().schema.link} />
            </Loading>
          </Errored>
        )}
      </Show>
      <h2>Linked from</h2>
      <section class="card">
        <Errored fallback={problemView}>
          <Loading fallback={<p class="note">Reading what links to it.</p>}>
            <LinkedFromView source={props.source} link={props.link} />
          </Loading>
        </Errored>
      </section>
    </>
  );
}
