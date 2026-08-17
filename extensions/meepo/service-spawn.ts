import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { getMeepoDb } from "./db.js";
import { ensureMeepoRuntimePaths } from "./paths.js";
import { getProjectKey } from "./project.js";
import { getProcessHost } from "./process-host.js";
import { shellQuote } from "./text-util.js";
import { createService, updateService } from "./service-registry.js";
import type { CreateServiceInput, ServiceStatusSnapshot, SpawnServiceInput, SpawnServiceResult } from "./service-types.js";

const READY_POLL_INTERVAL_MS = 250;

interface ServiceRunArtifacts {
	runDir: string;
	launchScript: string;
	commandFile: string;
	logFile: string;
	latestStatusFile: string;
}

function normalizeEnv(env: Record<string, string> | null | undefined): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(env ?? {})) {
		const name = key.trim();
		if (!name) continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			throw new Error(`Invalid environment variable name: ${key}`);
		}
		normalized[name] = String(value);
	}
	return normalized;
}

function buildLaunchScriptContent(options: {
	serviceId: string;
	spawnCwd: string;
	command: string;
	env: Record<string, string>;
	logFile: string;
	latestStatusFile: string;
}): string {
	const exportLines = Object.entries(options.env)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `export ${key}=${shellQuote(value)}`);
	return [
		"#!/usr/bin/env bash",
		"set -uo pipefail",
		`cd ${shellQuote(options.spawnCwd)}`,
		...exportLines,
		`: > ${shellQuote(options.logFile)}`,
		"started_at=\"$(date +%s%3N)\"",
		`printf '{\n  "serviceId": "%s",\n  "state": "running",\n  "updatedAt": %s\n}\n' ${shellQuote(options.serviceId)} "$started_at" > ${shellQuote(options.latestStatusFile)}`,
		`bash -lc ${shellQuote(options.command)} 2>&1 | tee -a ${shellQuote(options.logFile)}`,
		"status=${PIPESTATUS[0]}",
		"finished_at=\"$(date +%s%3N)\"",
		'final_state="stopped"',
		'if [ "$status" -ne 0 ] && [ "$status" -ne 130 ] && [ "$status" -ne 143 ]; then',
		'  final_state="error"',
		"fi",
		`printf '{\n  "serviceId": "%s",\n  "state": "%s",\n  "updatedAt": %s,\n  "lastExitCode": %s,\n  "finishedAt": %s\n}\n' ${shellQuote(options.serviceId)} "$final_state" "$finished_at" "$status" "$finished_at" > ${shellQuote(options.latestStatusFile)}`,
		"exit \"$status\"",
	].join("\n");
}

function writeRunArtifacts(options: {
	serviceId: string;
	title: string;
	command: string;
	spawnCwd: string;
	env: Record<string, string>;
}): ServiceRunArtifacts {
	const { serviceRunsDir } = ensureMeepoRuntimePaths();
	const runDir = join(serviceRunsDir, options.serviceId);
	mkdirSync(runDir, { recursive: true });
	const launchScript = join(runDir, "launch.sh");
	const commandFile = join(runDir, "command.txt");
	const logFile = join(runDir, "output.log");
	const latestStatusFile = join(runDir, "latest-status.json");
	writeFileSync(commandFile, `${options.command}\n`);
	writeFileSync(
		join(runDir, "metadata.json"),
		`${JSON.stringify(
			{
				serviceId: options.serviceId,
				title: options.title,
				spawnCwd: options.spawnCwd,
				env: options.env,
				createdAt: Date.now(),
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		latestStatusFile,
		`${JSON.stringify(
			{
				serviceId: options.serviceId,
				state: "launching",
				updatedAt: Date.now(),
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		launchScript,
		buildLaunchScriptContent({
			serviceId: options.serviceId,
			spawnCwd: options.spawnCwd,
			command: options.command,
			env: options.env,
			logFile,
			latestStatusFile,
		}),
	);
	chmodSync(launchScript, 0o755);
	return { runDir, launchScript, commandFile, logFile, latestStatusFile };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function readServiceStatus(statusFile: string): ServiceStatusSnapshot | null {
	if (!existsSync(statusFile)) return null;
	try {
		const parsed = JSON.parse(readFileSync(statusFile, "utf8")) as ServiceStatusSnapshot;
		if (!parsed || typeof parsed !== "object" || typeof parsed.serviceId !== "string" || typeof parsed.state !== "string") {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export function tailFileLines(path: string, lines = 200): string {
	if (!existsSync(path)) return "";
	try {
		const content = readFileSync(path, "utf8");
		const allLines = content.split(/\r?\n/);
		while (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
		return allLines.slice(-Math.max(1, lines)).join("\n");
	} catch {
		return "";
	}
}

async function waitForReadySubstring(options: {
	logFile: string;
	statusFile: string;
	readySubstring: string;
	timeoutMs: number;
}): Promise<{ matched: boolean; timedOut: boolean; statusSnapshot: ServiceStatusSnapshot | null }> {
	const deadline = Date.now() + Math.max(0, options.timeoutMs);
	while (Date.now() <= deadline) {
		const output = tailFileLines(options.logFile, 4000);
		if (output.includes(options.readySubstring)) {
			return {
				matched: true,
				timedOut: false,
				statusSnapshot: readServiceStatus(options.statusFile),
			};
		}
		const statusSnapshot = readServiceStatus(options.statusFile);
		if (statusSnapshot && ["stopped", "error"].includes(statusSnapshot.state)) {
			return {
				matched: false,
				timedOut: false,
				statusSnapshot,
			};
		}
		await sleep(READY_POLL_INTERVAL_MS);
	}
	return {
		matched: false,
		timedOut: true,
		statusSnapshot: readServiceStatus(options.statusFile),
	};
}

function deriveLastError(statusSnapshot: ServiceStatusSnapshot | null): string | null {
	if (!statusSnapshot) return null;
	if (statusSnapshot.lastError) return statusSnapshot.lastError;
	if (statusSnapshot.state === "error" && typeof statusSnapshot.lastExitCode === "number") {
		return `Command exited with status ${statusSnapshot.lastExitCode}.`;
	}
	return null;
}

export async function spawnService(input: SpawnServiceInput): Promise<SpawnServiceResult> {
	const now = Date.now();
	const serviceId = input.id ?? `svc_${now.toString(36)}_${randomUUID().slice(0, 8)}`;
	const spawnCwd = resolve(input.spawnCwd);
	const env = normalizeEnv(input.env);
	const readySubstring = input.readySubstring?.trim() || null;
	const runArtifacts = writeRunArtifacts({
		serviceId,
		title: input.title,
		command: input.command,
		spawnCwd,
		env,
	});
	const db = getMeepoDb();
	const serviceRecord: CreateServiceInput = {
		id: serviceId,
		spawnSessionId: input.spawnSessionId,
		spawnSessionFile: input.spawnSessionFile,
		spawnCwd,
		projectKey: getProjectKey(spawnCwd),
		title: input.title,
		command: input.command,
		env,
		readySubstring,
		state: "launching",
		runDir: runArtifacts.runDir,
		logFile: runArtifacts.logFile,
		latestStatusFile: runArtifacts.latestStatusFile,
		createdAt: now,
		updatedAt: now,
	};
	createService(db, serviceRecord);
	const host = getProcessHost();
	let hostTarget;
	try {
		hostTarget = await host.spawnWindow({
			title: input.title,
			entityId: serviceId,
			launchCommand: `exec ${shellQuote(runArtifacts.launchScript)}`,
			pool: "services",
			cwd: spawnCwd,
			env,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		updateService(db, serviceId, { state: "error", lastError: message, updatedAt: Date.now() });
		throw error;
	}
	updateService(db, serviceId, {
		state: "running",
		host: hostTarget,
		updatedAt: Date.now(),
	});
	await sleep(READY_POLL_INTERVAL_MS);
	let readyMatched = false;
	let readyTimedOut = false;
	let statusSnapshot = readServiceStatus(runArtifacts.latestStatusFile);
	if (readySubstring) {
		const waitResult = await waitForReadySubstring({
			logFile: runArtifacts.logFile,
			statusFile: runArtifacts.latestStatusFile,
			readySubstring,
			timeoutMs: Math.max(1, input.readyTimeoutSec ?? 20) * 1000,
		});
		readyMatched = waitResult.matched;
		readyTimedOut = waitResult.timedOut;
		statusSnapshot = waitResult.statusSnapshot;
		if (readyMatched) {
			updateService(db, serviceId, { readyMatchedAt: Date.now(), updatedAt: Date.now() });
		}
	} else if (statusSnapshot && statusSnapshot.state === "running") {
		readyMatched = false;
	}
	if (statusSnapshot) {
		updateService(db, serviceId, {
			state: statusSnapshot.state,
			updatedAt: statusSnapshot.updatedAt,
			finishedAt: statusSnapshot.finishedAt ?? null,
			lastExitCode: statusSnapshot.lastExitCode ?? null,
			lastError: deriveLastError(statusSnapshot),
		});
	}
	const initialOutput = tailFileLines(runArtifacts.logFile, 120);
	return {
		serviceId,
		title: input.title,
		command: input.command,
		spawnCwd,
		runDir: runArtifacts.runDir,
		logFile: runArtifacts.logFile,
		latestStatusFile: runArtifacts.latestStatusFile,
		readySubstring,
		readyMatched,
		readyTimedOut,
		state: statusSnapshot?.state ?? "running",
		statusSnapshot,
		initialOutput,
		host: hostTarget,
	};
}
