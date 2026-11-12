import { encodeSchema, type LinkValue, type Schema, type Value } from "@estoc/object";
import type { Field, Item } from "./document.ts";
import { schemaValidator } from "./validator.ts";

declare const value: unique symbol;

type Read<T> = { readonly [value]?: T };

/** A type as a schema writes it. `T` is what a program reads its values as: a label, as in a `Link<T>`. */
export type ItemOf<T> = Item & Read<T>;

/** An optional field of the type `ItemOf<T>`. */
export type OptionalOf<T> = Field & { readonly optional: true } & Read<T>;

/** A link. `T` is what the blob it names is read as, which the schema does not say. */
export const link = <T = unknown>(): ItemOf<LinkValue<T>> => ({ type: "link" });
export const bytes = (): ItemOf<Uint8Array> => ({ type: "bytes" });
/** An integer of at most 2^53 - 1 either way, which a number holds whole. */
export const integer = (): ItemOf<number> => ({ type: "integer" });
export const string = (): ItemOf<string> => ({ type: "string" });
export const boolean = (): ItemOf<boolean> => ({ type: "boolean" });
export const array = <T>(items: ItemOf<T>): ItemOf<readonly T[]> => ({ type: "array", items });
/** Any value of the object format: one of the six other types, or a map. The schema says no more of it. */
export const any = (): ItemOf<Value> => ({ type: "any" });
/** `field` as one an object may leave out. */
export const optional = <T>(field: ItemOf<T>): OptionalOf<T> => ({ ...field, optional: true });

type FieldsOf = { readonly [name: string]: ItemOf<unknown> | OptionalOf<unknown> };
type OptionalIn<F extends FieldsOf> = { [N in keyof F]: F[N] extends OptionalOf<unknown> ? N : never }[keyof F];
type ValueOf<F> = F extends Read<infer T> ? T : never;
type DataOfFields<F extends FieldsOf> = { readonly [N in Exclude<keyof F, OptionalIn<F>>]: ValueOf<F[N]> } & {
  readonly [N in OptionalIn<F>]?: ValueOf<F[N]>;
} extends infer D
  ? { readonly [N in keyof D]: D[N] }
  : never;

/**
 * The schema with `title` and `fields`, as a blob. What a program reads its
 * data as follows from the fields, and `DataOf` gives it.
 */
export function schema<F extends FieldsOf>(title: string, fields: F): Schema<DataOfFields<F>> {
  return encodeSchema({ title, fields }, schemaValidator);
}

/** What a program reads the data of an object written to `S` as. */
export type DataOf<S extends Schema> = S extends Schema<infer F> ? F : never;
