import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	HERDR_MAX_EXCLUSIVE_VERSION,
	HERDR_MIN_VERSION,
	HERDR_REQUIRED_PROTOCOL,
	assertSupportedHerdr,
	compareHerdrVersions,
	formatUnsupportedHerdrVersion,
	isSupportedHerdrVersion,
	parseHerdrVersionToken,
	probeHerdrCompatible,
	readHerdrVersion,
} from "./herdr-compat.js";

describe("herdr compat", () => {
	it("parses herdr --version tokens", () => {
		assert.equal(parseHerdrVersionToken("herdr 0.8.0"), "0.8.0");
		assert.equal(parseHerdrVersionToken("0.7.4\n"), "0.7.4");
		assert.equal(parseHerdrVersionToken("not a version"), null);
	});

	it("accepts the 0.8 series and rejects 0.7 / 0.9", () => {
		assert.equal(isSupportedHerdrVersion("0.8.0"), true);
		assert.equal(isSupportedHerdrVersion("0.8.9"), true);
		assert.equal(isSupportedHerdrVersion("0.7.4"), false);
		assert.equal(isSupportedHerdrVersion("0.9.0"), false);
		assert.ok(compareHerdrVersions(HERDR_MIN_VERSION, HERDR_MAX_EXCLUSIVE_VERSION) < 0);
	});

	it("assertSupportedHerdr names the required range", () => {
		assert.throws(
			() => assertSupportedHerdr({ version: "0.7.4", protocol: 16, raw: "herdr 0.7.4" }),
			/Unsupported herdr 0\.7\.4/,
		);
		assert.throws(
			() => assertSupportedHerdr({ version: "0.8.0", protocol: 16, raw: "herdr 0.8.0" }),
			/protocol 16/,
		);
		assert.doesNotThrow(() =>
			assertSupportedHerdr({ version: "0.8.0", protocol: HERDR_REQUIRED_PROTOCOL, raw: "herdr 0.8.0" }),
		);
		assert.match(formatUnsupportedHerdrVersion("0.7.4", 16), /MEEPO_PROCESS_HOST=tmux/);
	});

	it("readHerdrVersion pulls version and protocol from CLI text", () => {
		const info = readHerdrVersion((args) => {
			if (args[0] === "--version") {
				return { status: 0, stdout: "herdr 0.8.0\n", stderr: "" };
			}
			if (args[0] === "status") {
				return {
					status: 0,
					stdout: "client:\n  version: 0.8.0\n  protocol: 20\n\nserver:\n  protocol: 20\n",
					stderr: "",
				};
			}
			return { status: 1, stdout: "", stderr: "nope" };
		});
		assert.deepEqual(info, { version: "0.8.0", protocol: 20, raw: "herdr 0.8.0" });
	});

	it("probeHerdrCompatible is false for missing or old herdr", () => {
		assert.equal(probeHerdrCompatible({ commandExists: () => false }), false);
		assert.equal(
			probeHerdrCompatible({
				commandExists: () => true,
				readVersion: () => ({ version: "0.7.4", protocol: 16, raw: "herdr 0.7.4" }),
			}),
			false,
		);
		assert.equal(
			probeHerdrCompatible({
				commandExists: () => true,
				readVersion: () => ({ version: "0.8.0", protocol: 20, raw: "herdr 0.8.0" }),
			}),
			true,
		);
	});
});
