import type { Link, Schema } from "@estoc/object";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import {
  type ActionForm,
  type ActionSource,
  entryOf,
  type FormField,
  readActionForms,
  type TitledSchema,
} from "./action-page.ts";
import type { ActionSessions } from "./action-sessions.ts";
import { blobPageView } from "./blob-view.tsx";
import { messageOf, typeNameOf } from "./text.ts";
import { linkView } from "./value-view.tsx";

const titledSchemaView = ({ link, title }: TitledSchema): JSX.Element => (
  <>
    <span class="title">{title}</span> {linkView(link)}
  </>
);

function inputView({ name, field }: FormField, texts: Map<string, string>): JSX.Element {
  const entry = entryOf(field);
  if (entry === undefined) return <span class="muted">The page has no input for this type.</span>;
  const keep = (event: { currentTarget: { value: string } }) => texts.set(name, event.currentTarget.value);
  return entry === "links" ? (
    <textarea class="mono" aria-label={name} rows="3" spellcheck={false} value={texts.get(name) ?? ""} onInput={keep} />
  ) : (
    <input
      class="mono"
      type="text"
      aria-label={name}
      autocomplete="off"
      spellcheck={false}
      value={texts.get(name) ?? ""}
      onInput={keep}
    />
  );
}

function FormView(props: { form: ActionForm; sessions: ActionSessions }) {
  const action = () => props.form.request.link;
  const state = () => props.sessions.stateOf(action());
  const failed = () => {
    const held = state();
    return held?.kind === "failed" ? held : undefined;
  };
  const performed = () => {
    const held = state();
    return held?.kind === "performed" ? held : undefined;
  };
  return (
    <>
      <h1>{props.form.title}</h1>
      <form
        class="card"
        onSubmit={(event) => {
          event.preventDefault();
          void props.sessions.perform(props.form);
        }}
      >
        <dl class="head">
          <dt>Request</dt>
          <dd>{titledSchemaView({ link: action(), title: props.form.title })}</dd>
          <dt>Result</dt>
          <dd>{titledSchemaView(props.form.result)}</dd>
        </dl>
        <Show when={props.form.fields.length > 0}>
          <table class="fields">
            <thead>
              <tr>
                <th>Field</th>
                <th>Value</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.form.fields}>
                {(field) => (
                  <tr>
                    <td>
                      <span class="mono name">{field.name}</span>
                    </td>
                    <td>{inputView(field, props.sessions.textsOf(action()))}</td>
                    <td>
                      <span class="mono">{typeNameOf(field.field)}</span>
                      {field.field.optional === true && <span class="muted"> · optional</span>}
                      {field.target !== undefined && (
                        <>
                          <span class="muted"> · to </span>
                          <a class="link" href={`#${field.target.link}`} title={field.target.link}>
                            {field.target.title}
                          </a>
                        </>
                      )}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
        <p class="perform">
          <button type="submit" disabled={state()?.kind === "performing"}>
            Perform
          </button>
          <Show when={state()?.kind === "performing"}>
            <span class="muted">The runtime is performing it.</span>
          </Show>
        </p>
      </form>
      <Switch>
        <Match when={failed()}>
          {(failed) => (
            <p class="problem" role="alert">
              {messageOf(failed().error)}
            </p>
          )}
        </Match>
        <Match when={performed()}>
          {(performed) => (
            <>
              <h2>Result</h2>
              <section class="card">{blobPageView(performed().result)}</section>
              <h2>Commits</h2>
              <section class="card">
                <Show
                  when={performed().commits.length > 0}
                  fallback={<p class="note">The action committed nothing.</p>}
                >
                  <ul class="items commits">
                    <For each={performed().commits}>{(commit) => <li>{linkView(commit)}</li>}</For>
                  </ul>
                </Show>
              </section>
            </>
          )}
        </Match>
      </Switch>
    </>
  );
}

export function ActionView(props: { source: ActionSource; action: Link<Schema>; sessions: ActionSessions }) {
  const forms = createMemo(() => readActionForms(props.source));
  const form = createMemo(() => forms().find(({ request }) => request.link === props.action));
  return (
    <Show
      when={form()}
      keyed
      fallback={<p class="note">The runtime lists no action that takes a request written to that schema.</p>}
    >
      {(shown) => <FormView form={shown} sessions={props.sessions} />}
    </Show>
  );
}
