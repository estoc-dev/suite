import { encodeSchema, type LinkValue, type Schema, type Value } from "@estoc/object";
import type { Field, Item } from "./document.ts";
import { schemaValidator } from "./validator.ts";

declare const value: unique symbol;

type Read<T> = { readonly [value]?: T };

export type ItemOf<T> = Item & Read<T>;

export type OptionalOf<T> = Field & { readonly optional: true } & Read<T>;

export const link = <T = unknown>(): ItemOf<LinkValue<T>> => ({ type: "link" });
export const bytes = (): ItemOf<Uint8Array> => ({ type: "bytes" });
/** At most 2^53 - 1 either way, which a number holds whole. */
export const integer = (): ItemOf<number> => ({ type: "integer" });
export const string = (): ItemOf<string> => ({ type: "string" });
export const boolean = (): ItemOf<boolean> => ({ type: "boolean" });
export const array = <T>(items: ItemOf<T>): ItemOf<readonly T[]> => ({ type: "array", items });
export const any = (): ItemOf<Value> => ({ type: "any" });
export const optional = <T>(field: ItemOf<T>): OptionalOf<T> => ({ ...field, optional: true });

type FieldsOf = { readonly [name: string]: ItemOf<unknown> | OptionalOf<unknown> };
type OptionalIn<F extends FieldsOf> = { [N in keyof F]: F[N] extends OptionalOf<unknown> ? N : never }[keyof F];
type ValueOf<F> = F extends Read<infer T> ? T : never;
type DataOfFields<F extends FieldsOf> = { readonly [N in Exclude<keyof F, OptionalIn<F>>]: ValueOf<F[N]> } & {
  readonly [N in OptionalIn<F>]?: ValueOf<F[N]>;
} extends infer D
  ? { readonly [N in keyof D]: D[N] }
  : never;

export function schema<F extends FieldsOf>(title: string, fields: F): Schema<DataOfFields<F>> {
  return encodeSchema({ title, fields }, schemaValidator);
}

export type DataOf<S extends Schema> = S extends Schema<infer F> ? F : never;
