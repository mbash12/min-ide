/* Bun global shim for the vendored @oh-my-pi sources running under Node/
 * Electron. Injected by esbuild (`inject`) so every `Bun.*` reference in the
 * bundle resolves here. Only the surface the provider import graph touches is
 * implemented — extend it when a sync pulls in a new Bun API. */

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";

// Shared with the CommonJS native shim; resolve optional addons beside the bundle.
export const minOmpNativeRequire = createRequire(import.meta.url);

function toBytes(data: unknown): Buffer {
	if (typeof data === "string") return Buffer.from(data, "utf8");
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	return Buffer.from(String(data));
}

/* Bun.hash returns a fast non-crypto hash (number); xxHash64 returns bigint.
 * Only determinism matters for the call sites (tool-call ids, cache keys,
 * message projections) — sha256 truncated is a fine stand-in. */
function bunHash(data: unknown, seed?: number | bigint): number {
	const h = crypto.createHash("sha256");
	if (seed !== undefined) h.update(Buffer.from(String(seed)));
	h.update(toBytes(data));
	return Number(h.digest().readBigUInt64LE(0) & BigInt("0x1fffffffffffff"));
}
bunHash.xxHash64 = (data: unknown, seed?: number | bigint): bigint => {
	const h = crypto.createHash("sha256");
	if (seed !== undefined) h.update(Buffer.from(String(seed)));
	h.update(toBytes(data));
	return h.digest().readBigUInt64LE(0);
};
bunHash.xxHash32 = (data: unknown, seed?: number | bigint): number => {
	const h = crypto.createHash("sha256");
	if (seed !== undefined) h.update(Buffer.from(String(seed)));
	h.update(toBytes(data));
	return h.digest().readUInt32LE(0);
};

class BunFileShim {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
	async text() {
		return fs.promises.readFile(this.path, "utf8");
	}
	async json() {
		return JSON.parse(await this.text());
	}
	async bytes() {
		return fs.promises.readFile(this.path);
	}
	async arrayBuffer() {
		const buf = await fs.promises.readFile(this.path);
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	}
	async exists() {
		return fs.existsSync(this.path);
	}
}

/* Minimal image metadata reader covering png/jpeg/gif/webp — enough for the
 * providers' dimension checks. resize() intentionally throws: oversized-image
 * downscaling is a rare path and silently returning unresized bytes would send
 * a request the provider will reject anyway. */
class BunImageShim {
	#buf: Buffer;
	constructor(input: ArrayBuffer | Uint8Array | Buffer) {
		this.#buf = toBytes(input);
	}
	async metadata(): Promise<{ width: number; height: number }> {
		const b = this.#buf;
		// png: IHDR at bytes 16..24
		if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
			return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
		}
		// gif: logical screen descriptor at bytes 6..10
		if (b.length > 10 && b.toString("ascii", 0, 3) === "GIF") {
			return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
		}
		// webp: VP8/VP8L/VP8X headers
		if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
			const kind = b.toString("ascii", 12, 16);
			if (kind === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
			if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
			if (kind === "VP8L") {
				const bits = b.readUInt32LE(21);
				return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
			}
		}
		// jpeg: scan for SOF markers
		if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
			let off = 2;
			while (off + 9 < b.length) {
				if (b[off] !== 0xff) { off++; continue; }
				const marker = b[off + 1];
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return { height: b.readUInt16BE(off + 5), width: b.readUInt16BE(off + 7) };
				}
				off += 2 + b.readUInt16BE(off + 2);
			}
		}
		throw new Error("Bun.Image shim: unrecognized image format");
	}
	resize() {
		throw new Error("Bun.Image shim: resize not supported under Node");
	}
}

export const Bun = {
	env: process.env,
	hash: bunHash,
	sha: (text: unknown, format?: string) => crypto.createHash("sha256").update(toBytes(text)).digest(format === "hex" ? "hex" : undefined),
	CryptoHasher: class {
		#h: crypto.Hash;
		constructor(algo: string) {
			this.#h = crypto.createHash(algo);
		}
		update(data: unknown) {
			this.#h.update(toBytes(data));
			return this;
		}
		digest(format?: string) {
			return this.#h.digest(format === "hex" || format === "base64" ? format : undefined);
		}
	},
	file: (path: string) => new BunFileShim(path),
	write: (path: string, data: unknown) => fs.promises.writeFile(path, toBytes(data)),
	Image: BunImageShim,
	randomUUIDv7: () => crypto.randomUUID(),
	guid: () => crypto.randomUUID(),
	sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
	which: (name: string) => name,
	spawn: () => {
		throw new Error("Bun.spawn is not available under Node");
	},
};
