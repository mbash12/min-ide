/*
 * Node-compatible shim for @oh-my-pi/pi-natives.
 *
 * The upstream package resolves its .node addon through Bun-only
 * `import.meta.dir`, which crashes under Node/Electron. The platform
 * binaries themselves work fine in Node, so load them directly via
 * createRequire and re-export the surface the provider graph imports.
 */
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const platformTag = `${process.platform}-${process.arch}`;

interface NativeAddon {
	FileLock?: unknown;
	Process?: unknown;
	ProcessStatus?: unknown;
	NativeOAuthCallback?: unknown;
	renderMermaidAscii?: unknown;
	[key: string]: unknown;
}

let addon: NativeAddon = {};
const candidates = [
	`@oh-my-pi/pi-natives-${platformTag}/pi_natives.${platformTag}-modern.node`,
	`@oh-my-pi/pi-natives-${platformTag}/pi_natives.${platformTag}-baseline.node`,
];
for (const spec of candidates) {
	try {
		addon = req(spec) as NativeAddon;
		break;
	} catch {
		/* try the next variant */
	}
}

function unavailable(name: string): never {
	throw new Error(`@oh-my-pi/pi-natives ${name} unavailable: no native addon for ${platformTag}`);
}

class FileLockFallback {
	constructor(..._args: unknown[]) {
		unavailable("FileLock");
	}
}
class ProcessFallback {
	constructor(..._args: unknown[]) {
		unavailable("Process");
	}
}
class NativeOAuthCallbackFallback {
	constructor(..._args: unknown[]) {
		unavailable("NativeOAuthCallback");
	}
}

export const FileLock = (addon.FileLock ?? FileLockFallback) as typeof FileLockFallback;
export const Process = (addon.Process ?? ProcessFallback) as typeof ProcessFallback;
export const ProcessStatus = (addon.ProcessStatus ?? {}) as Record<string, unknown>;
export const NativeOAuthCallback = (addon.NativeOAuthCallback ??
	NativeOAuthCallbackFallback) as typeof NativeOAuthCallbackFallback;
export const renderMermaidAscii = (addon.renderMermaidAscii ??
	((..._args: unknown[]) => unavailable("renderMermaidAscii"))) as (...args: unknown[]) => string;
export default addon;
