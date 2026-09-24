/* Module shims for `bun` / `bun:*` imports inside the vendored @oh-my-pi
 * graph. esbuild aliases these specifiers here; members are only exercised if
 * the imported graph actually reaches them. */

import yaml from "js-yaml";

/* `import { YAML } from "bun"` — Bun's YAML maps onto js-yaml's load/dump. */
export const YAML = {
	parse: (text: string) => yaml.load(text),
	stringify: (value: unknown) => yaml.dump(value),
};

/* `import { Database, Statement } from "bun:sqlite"` — Node 22+ has a
 * compatible DatabaseSync. */
export { DatabaseSync as Database, DatabaseSync as SQLDatabase, StatementSync as Statement } from "node:sqlite";

/* `import { $, Cookie, CookieMap } from "bun"` — shell and cookie helpers are
 * only used by flows Min never reaches; stubs fail loudly instead of silently
 * corrupting state. */
export const $ = () => {
	throw new Error("Bun.$ shell is not available under Node");
};
export class Cookie {}
export class CookieMap {}
export const plugin = () => {};

/* `import { dlopen, FFIType, ptr } from "bun:ffi"` — native FFI is out of
 * scope for the provider graph. */
export const dlopen = () => {
	throw new Error("bun:ffi is not available under Node");
};
export const ptr = () => 0;
export const FFIType = {};
