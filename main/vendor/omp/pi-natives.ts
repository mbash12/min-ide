/*
 * Node-compatible shim for @oh-my-pi/pi-natives.
 *
 * The upstream package resolves its .node addon through Bun-only
 * `import.meta.dir`, which crashes under Node/Electron. The platform
 * binaries themselves work fine in Node, so load them directly via
 * createRequire and expose its exports as CommonJS. OMP's shared provider
 * graph also imports optional native features for providers Min does not
 * offer (such as Apple's local models). Adding those upstream imports must
 * not prevent updates to Min's existing HTTP transports from bundling.
 */
import { minOmpNativeRequire as req } from "./bun-globals";
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

module.exports = {
	...addon,
	FileLock: addon.FileLock ?? FileLockFallback,
	Process: addon.Process ?? ProcessFallback,
	ProcessStatus: addon.ProcessStatus ?? {},
	NativeOAuthCallback: addon.NativeOAuthCallback ?? NativeOAuthCallbackFallback,
	renderMermaidAscii: addon.renderMermaidAscii ?? (() => unavailable("renderMermaidAscii")),
};
