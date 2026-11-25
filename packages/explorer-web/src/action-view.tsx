import type { Link, Schema } from "@estoc/object";
import type { JSX } from "@solidjs/web";
import { createMemo, Errored, For, Loading, Match, Show, Switch } from "solid-js";
import { entryOf, type FormField, type TitledSchema } from "./action-page.ts";
import type { ActionSession, ActionSessions } from "./action-sessions.ts";
import { blobPageView } from "./blob-view.tsx";
import { remainingLinksView } from "./links-view.tsx";
import { messageOf, typeNameOf } from "./text.ts";
import { linkView } from "./value-view.tsx";

const titledSchemaView = ({ schema, title }: TitledSchema): JSX.Element => (
  <>
    <span class="title">{title}</span> {linkView(schema.link)}
  </>
);

function CandidatesView(props: { session: ActionSession; name: string; target: TitledSchema; isAdded: boolean }) {
  const target = () => props.target.schema.link;
  const objects = createMemo(() => props.session.readObjectsOf(target()));
  const take = (object: Link<unknown>) => {
    const fieldText = props.session.textOf(props.name).trim();
    props.session.setText(props.name, props.isAdded && fieldText !== "" ? `${fieldText}\n${object}` : object);
  };
  return (
    <Errored fallback={(error) => <span class="problem">{messageOf(error())}</span>}>
      <Loading fallback={<span class="muted">Reading the objects held.</span>}>
        <Show
          when={objects().links.length > 0}
          fallback={<span class="muted">The store holds no object written to {props.target.title}.</span>}
        >
          <ul class="items candidates">
            <For each={objects().links}>
              {(object) => (
                <li>
                  <button type="button" class="quiet" onClick={() => take(object)}>
                    {props.isAdded ? "Add" : "Use"}
                  </button>
                  {linkView(object)}
                </li>
              )}
            </For>
          </ul>
          {remainingLinksView(objects(), { objectsOf: target() })}
        </Show>
      </Loading>
    </Errored>
  );
}

function inputView({ name, field, target }: FormField, session: ActionSession): JSX.Element {
  const entry = entryOf(field);
  if (entry === undefined) return <span class="muted">The page has no input for this type.</span>;
  const keep = (event: { currentTarget: { value: string } }) => session.setText(name, event.currentTarget.value);
  return (
    <>
      {entry === "links" ? (
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
      )}
      {entry !== "text" && target !== undefined && (
        <CandidatesView session={session} name={name} target={target} isAdded={entry === "links"} />
      )}
    </>
  );
}

function ResultView(props: { session: ActionSession; result: Uint8Array }) {
  const page = createMemo(() => props.session.readPageOf(props.result));
  return <Loading fallback={<p class="note">Reading the result.</p>}>{blobPageView(page())}</Loading>;
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
          <dd>{titledSchemaView({ schema: form().request, title: form().title })}</dd>
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
                    <td class="entry">{inputView(field, props.session)}</td>
                    <td>
                      <span class="mono">{typeNameOf(field.field)}</span>
                      {field.field.optional === true && <span class="muted"> · optional</span>}
                      {field.target !== undefined && (
                        <>
                          <span class="muted"> · to </span>
                          <a class="link" href={`#${field.target.schema.link}`} title={field.target.schema.link}>
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
                <ResultView session={props.session} result={performed().result} />
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
  const session = createMemo(() => props.sessions.sessionOf(props.action));
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
