/* Bundles the vendored @oh-my-pi provider sources into one ESM file the
 * Electron main bundle can import lazily (main/agentOAuth.js). The upstream
 * code is TypeScript with Bun API calls; esbuild transpiles + bundles it and
 * main/vendor/omp/bun-*.ts provides the Bun shims.
 *
 * Sync workflow: bump the @oh-my-pi/* devDependencies and re-run. */

import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendorDir = path.join(root, "main", "vendor", "omp");

await esbuild.build({
	entryPoints: [path.join(vendorDir, "entry.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	outfile: path.join(vendorDir, "bundle.mjs"),
	/* the inject file's exports become globals: `Bun` resolves to the shim */
	inject: [path.join(vendorDir, "bun-globals.ts")],
	define: {
		/* Bun's import.meta.dir == Node's import.meta.dirname */
		"import.meta.dir": "import.meta.dirname",
	},
	alias: {
		bun: path.join(vendorDir, "bun-modules.ts"),
		"bun:sqlite": path.join(vendorDir, "bun-modules.ts"),
		"bun:ffi": path.join(vendorDir, "bun-modules.ts"),
		"bun:jsc": path.join(vendorDir, "bun-modules.ts"),
		/* upstream resolves the native addon via Bun-only import.meta.dir */
		"@oh-my-pi/pi-natives": path.join(vendorDir, "pi-natives.ts"),
	},
	loader: {
		".md": "text",
		".proto": "text",
	},
	external: ["electron"],
	plugins: [{
		name: "omp-package-json",
		setup(build) {
			/* @oh-my-pi sources import their own package.json for version/engine
			metadata; the package "exports" map doesn't expose it and esbuild
			enforces exports even on relative paths, so load it via a namespace
			that skips resolution entirely. */
			build.onResolve({ filter: /(^|\/)package\.json$/ }, (args) => ({
				path: path.resolve(args.resolveDir, args.path),
				namespace: "omp-pkg-json",
			}));
			build.onLoad({ filter: /.*/, namespace: "omp-pkg-json" }, async (args) => ({
				contents: await fs.promises.readFile(args.path, "utf8"),
				loader: "json",
			}));
		},
	}],
	logLevel: "info",
});

console.log("omp provider bundle written to main/vendor/omp/bundle.mjs");

const readPackage = (name) => JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8"));
fs.writeFileSync(path.join(vendorDir, "manifest.json"), JSON.stringify({
	version: readPackage("@oh-my-pi/pi-ai").version,
	esbuildVersion: readPackage("esbuild").version,
	yamlVersion: readPackage("js-yaml").version,
	builtAt: new Date().toISOString(),
}, null, 2));
// Ship the same builder and adapter sources for isolated, on-demand updates.
fs.copyFileSync(fileURLToPath(import.meta.url), path.join(vendorDir, "build.mjs"));
