import type { Link } from "@estoc/object";
import { createSignal } from "solid-js";
import {
  type ActionForm,
  type ActionSource,
  type ResultPage,
  readActionForms,
  readResultPage,
  requestOf,
} from "./action-page.ts";

export type ActionState =
  | { readonly kind: "performing" }
  | { readonly kind: "failed"; readonly error: unknown }
  | {
      readonly kind: "performed";
      readonly commits: readonly Link<unknown>[];
      readonly result: Promise<ResultPage>;
    };

/**
 * What the page holds of one action while it is open: its form, what was typed into it and how the
 * last request went. The runtime gives a reply once and keeps none for the page, so leaving the
 * page of an action for a blob that its result links to would otherwise lose the result.
 */
export class ActionSession {
  readonly form: ActionForm;
  readonly #source: ActionSource;
  readonly #texts = new Map<string, string>();
  readonly #state;
  readonly #setState;

  constructor(source: ActionSource, form: ActionForm) {
    this.#source = source;
    this.form = form;
    [this.#state, this.#setState] = createSignal<ActionState | undefined>(undefined);
  }

  textOf(field: string): string {
    return this.#texts.get(field) ?? "";
  }

  setText(field: string, text: string): void {
    this.#texts.set(field, text);
  }

  state(): ActionState | undefined {
    return this.#state();
  }

  async perform(): Promise<void> {
    this.#setState({ kind: "performing" });
    try {
      const { result, commits } = await this.#source.perform(requestOf(this.form, this.#texts));
      this.#setState({ kind: "performed", commits, result: readResultPage(this.#source, result) });
    } catch (error) {
      this.#setState({ kind: "failed", error });
    }
  }
}

/** A runtime lists the same actions for as long as it runs, so the page reads their forms once. */
export class ActionSessions {
  readonly #source: ActionSource;
  #sessions: Promise<readonly ActionSession[]> | undefined;

  constructor(source: ActionSource) {
    this.#source = source;
  }

  all(): Promise<readonly ActionSession[]> {
    this.#sessions ??= readActionForms(this.#source).then((forms) =>
      forms.map((form) => new ActionSession(this.#source, form)),
    );
    return this.#sessions;
  }
}
