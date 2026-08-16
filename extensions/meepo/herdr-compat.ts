/**
 * herdr version/protocol contract for Meepo's HerdProcessHost.
 *
 * Supported: herdr 0.8.x (protocol 20). cwd is a `tab create` flag; children
 * occupy that pane with `pane run`. Older `agent start --cwd` CLIs are unsupported.
 */

import { spawnSync } from "node:child_process";

/** Inclusive floor. */
export const HERDR_MIN_VERSION = "0.8.0";
/** Exclusive ceiling — bump when Meepo is ported past this series. */
export const HERDR_MAX_EXCLUSIVE_VERSION = "0.9.0";
export const HERDR_REQUIRED_PROTOCOL = 20;

export interface HerdrVersionInfo {
	version: string;
	protocol: number | null;
	raw: string;
}

export type HerdrProbe =
	| { status: "ok"; info: HerdrVersionInfo }
	| { status: "missing" }
	| { status: "unsupported"; info: HerdrVersionInfo };

export function parseHerdrVersionToken(raw: string): string | null {
	const match = raw.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
	return match?.[1] ?? null;
}

/** Compare dotted versions. Pre-release suffix is ignored for the numeric tuple. */
export function compareHerdrVersions(a: string, b: string): number {
	const pa = numericParts(a);
	const pb = numericParts(b);
	const n = Math.max(pa.length, pb.length);
	for (let i = 0; i < n; i += 1) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) return da < db ? -1 : 1;
	}
	return 0;
}

function numericParts(version: string): number[] {
	const core = version.split("-")[0]?.split("+")[0] ?? version;
	return core.split(".").map((part) => {
		const n = Number.parseInt(part, 10);
		return Number.isFinite(n) ? n : 0;
	});
}

export function isSupportedHerdrVersion(version: string): boolean {
	return (
		compareHerdrVersions(version, HERDR_MIN_VERSION) >= 0 &&
		compareHerdrVersions(version, HERDR_MAX_EXCLUSIVE_VERSION) < 0
	);
}

export function isSupportedHerdr(info: HerdrVersionInfo): boolean {
	if (!isSupportedHerdrVersion(info.version)) return false;
	if (info.protocol != null && info.protocol !== HERDR_REQUIRED_PROTOCOL) return false;
	return true;
}

export function formatUnsupportedHerdrVersion(version: string, protocol?: number | null): string {
	const proto = protocol != null ? ` (protocol ${protocol})` : "";
	return (
		`Unsupported herdr ${version}${proto}. Meepo requires herdr >= ${HERDR_MIN_VERSION} and < ${HERDR_MAX_EXCLUSIVE_VERSION}` +
		` (protocol ${HERDR_REQUIRED_PROTOCOL}). Pin herdr or set MEEPO_PROCESS_HOST=tmux.`
	);
}

export function unsupportedHerdrMessage(info: HerdrVersionInfo): string {
	return formatUnsupportedHerdrVersion(info.version, info.protocol);
}

export function missingHerdrMessage(): string {
	return "MEEPO_PROCESS_HOST=herdr (or runtime.processHost=herdr) but herdr is not available on PATH / failed version probe.";
}

export function readHerdrVersion(
	run?: (args: string[]) => { status: number | null; stdout: string; stderr: string },
): HerdrVersionInfo | null {
	const invoke =
		run ??
		((args: string[]) => {
			const result = spawnSync("herdr", args, { encoding: "utf8", timeout: 4000 });
			return {
				status: result.status,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
			};
		});

	const versionResult = invoke(["--version"]);
	if (versionResult.status !== 0) return null;
	const versionRaw = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
	const version = parseHerdrVersionToken(versionRaw);
	if (!version) return null;

	let protocol: number | null = null;
	const statusResult = invoke(["status"]);
	if (statusResult.status === 0) {
		const statusText = `${statusResult.stdout}\n${statusResult.stderr}`;
		const protoMatch = statusText.match(/protocol:\s*(\d+)/);
		if (protoMatch) protocol = Number.parseInt(protoMatch[1], 10);
	}

	return { version, protocol, raw: versionRaw };
}

/** PATH + --version + supported range. One result for factory + availability. */
export function probeHerdr(
	options: {
		commandExists?: () => boolean;
		readVersion?: () => HerdrVersionInfo | null;
	} = {},
): HerdrProbe {
	const exists =
		options.commandExists ??
		(() => {
			const result = spawnSync("bash", ["-lc", "command -v herdr >/dev/null 2>&1"], { stdio: "ignore" });
			return result.status === 0;
		});
	if (!exists()) return { status: "missing" };
	const info = (options.readVersion ?? readHerdrVersion)();
	if (!info) return { status: "missing" };
	if (!isSupportedHerdr(info)) return { status: "unsupported", info };
	return { status: "ok", info };
}
