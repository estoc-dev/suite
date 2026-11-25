import type { Link, Schema } from "@estoc/object";
import { createSignal } from "solid-js";
import { type ActionForm, type ActionSource, type Outcome, performForm } from "./action-page.ts";

export type ActionState = Outcome | { readonly kind: "performing" };

/**
 * What the page holds of each action while it is open: what was typed into the form and how the
 * last request went. A result is in no store, so leaving the page of an action for a blob that its
 * result links to would otherwise lose the result.
 */
export class ActionSessions {
  readonly #source: ActionSource;
  readonly #texts = new Map<Link<Schema>, Map<string, string>>();
  readonly #states;
  readonly #setStates;

  constructor(source: ActionSource) {
    this.#source = source;
    [this.#states, this.#setStates] = createSignal<ReadonlyMap<Link<Schema>, ActionState>>(new Map());
  }

  /** What was typed for each field of the action, by the name of the field. The form writes to it. */
  textsOf(action: Link<Schema>): Map<string, string> {
    let texts = this.#texts.get(action);
    if (texts === undefined) {
      texts = new Map();
      this.#texts.set(action, texts);
    }
    return texts;
  }

  stateOf(action: Link<Schema>): ActionState | undefined {
    return this.#states().get(action);
  }

  async perform(form: ActionForm): Promise<void> {
    const action = form.request.link;
    const setState = (state: ActionState) => this.#setStates((states) => new Map(states).set(action, state));
    setState({ kind: "performing" });
    setState(await performForm(this.#source, form, this.textsOf(action)));
  }
}
