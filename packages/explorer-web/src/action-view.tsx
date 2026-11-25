import type { Link, Schema } from "@estoc/object";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Loading, Match, Show, Switch } from "solid-js";
import { entryOf, type FormField, type ResultPage, type TitledSchema } from "./action-page.ts";
import type { ActionSession, ActionSessions } from "./action-sessions.ts";
import { blobPageView } from "./blob-view.tsx";
import { messageOf, typeNameOf } from "./text.ts";
import { linkView } from "./value-view.tsx";

const titledSchemaView = ({ link, title }: TitledSchema): JSX.Element => (
  <>
    <span class="title">{title}</span> {linkView(link)}
  </>
);

function inputView({ name, field }: FormField, session: ActionSession): JSX.Element {
  const entry = entryOf(field);
  if (entry === undefined) return <span class="muted">The page has no input for this type.</span>;
  const keep = (event: { currentTarget: { value: string } }) => session.setText(name, event.currentTarget.value);
  return entry === "links" ? (
    <>
      <textarea
        class="mono"
        aria-label={name}
        rows="3"
        spellcheck={false}
        value={session.textOf(name)}
        onInput={keep}
      />
      <span class="muted">Separate links with spaces or new lines.</span>
    </>
  ) : (
    <input
      class="mono"
      type="text"
      aria-label={name}
      autocomplete="off"
      spellcheck={false}
      value={session.textOf(name)}
      onInput={keep}
    />
  );
}

function ResultView(props: { result: Promise<ResultPage> }) {
  const result = createMemo(() => props.result);
  const read = () => {
    const held = result();
    return held.kind === "read" ? held.page : undefined;
  };
  const unread = () => {
    const held = result();
    return held.kind === "unread" ? held : undefined;
  };
  return (
    <Loading fallback={<p class="note">Reading the result.</p>}>
      <Switch>
        <Match when={read()}>{(page) => <>{blobPageView(page())}</>}</Match>
        <Match when={unread()}>
          {(unread) => (
            <p class="problem" role="alert">
              The result could not be read: {messageOf(unread().error)}
            </p>
          )}
        </Match>
      </Switch>
    </Loading>
  );
}

function FormView(props: { session: ActionSession }) {
  const form = () => props.session.form;
  const state = () => props.session.state();
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
      <h1>{form().title}</h1>
      <form
        class="card"
        onSubmit={(event) => {
          event.preventDefault();
          void props.session.perform();
        }}
      >
        <dl class="head">
          <dt>Request</dt>
          <dd>{titledSchemaView({ link: form().request.link, title: form().title })}</dd>
          <dt>Result</dt>
          <dd>{titledSchemaView(form().result)}</dd>
        </dl>
        <Show when={form().fields.length > 0}>
          <table class="fields">
            <thead>
              <tr>
                <th>Field</th>
                <th>Value</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              <For each={form().fields}>
                {(field) => (
                  <tr>
                    <td>
                      <span class="mono name">{field.name}</span>
                    </td>
                    <td>{inputView(field, props.session)}</td>
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
              <section class="card">
                <ResultView result={performed().result} />
              </section>
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

export function ActionView(props: { sessions: ActionSessions; action: Link<Schema> }) {
  const sessions = createMemo(() => props.sessions.all());
  const session = createMemo(() => sessions().find(({ form }) => form.request.link === props.action));
  return (
    <Show
      when={session()}
      keyed
      fallback={<p class="note">The runtime lists no action that takes a request written to that schema.</p>}
    >
      {(shown) => <FormView session={shown} />}
    </Show>
  );
}
