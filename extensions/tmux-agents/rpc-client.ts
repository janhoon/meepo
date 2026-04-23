import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import type { AgentSummary, RpcBridgeCommandRequest, RpcBridgeCommandResponse, RpcBridgeStatusSnapshot } from "./types.js";

const DEFAULT_TIMEOUT_MS = 7000;

function parseJson<T>(value: string): T | null {
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}

export function readRpcBridgeStatus(path: string | null | undefined): RpcBridgeStatusSnapshot | null {
	if (!path || !existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as RpcBridgeStatusSnapshot;
		if (!parsed || typeof parsed !== "object" || parsed.transportKind !== "rpc_bridge") return null;
		return parsed;
	} catch {
		return null;
	}
}

export function isRpcBridgeBackedAgent(agent: Pick<AgentSummary, "transportKind">): boolean {
	return agent.transportKind === "rpc_bridge";
}

export function getRpcBridgeSocketPath(agent: Pick<AgentSummary, "bridgeSocketPath" | "bridgeStatusFile">): string | null {
	if (agent.bridgeSocketPath) return agent.bridgeSocketPath;
	const status = readRpcBridgeStatus(agent.bridgeStatusFile);
	return status?.socketPath ?? null;
}

export async function sendRpcBridgeCommand(
	socketPath: string,
	command: Omit<RpcBridgeCommandRequest, "id">,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RpcBridgeCommandResponse> {
	return new Promise<RpcBridgeCommandResponse>((resolvePromise, reject) => {
		const socket = new Socket();
		const id = randomUUID();
		let settled = false;
		let buffer = "";

		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			try {
				socket.destroy();
			} catch {
				// Ignore socket cleanup errors.
			}
			callback();
		};

		const timer = setTimeout(() => {
			finish(() => reject(new Error(`Timed out waiting for RPC bridge response after ${timeoutMs}ms.`)));
		}, Math.max(1, timeoutMs));

		const handleLine = (line: string): void => {
			if (!line.trim()) return;
			const response = parseJson<RpcBridgeCommandResponse>(line);
			if (!response || response.id !== id) return;
			clearTimeout(timer);
			finish(() => resolvePromise(response));
		};

		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});

		socket.on("error", (error) => {
			clearTimeout(timer);
			finish(() => reject(error));
		});

		socket.on("close", () => {
			if (settled) return;
			clearTimeout(timer);
			finish(() => reject(new Error("RPC bridge connection closed before a response was received.")));
		});

		socket.connect(socketPath, () => {
			const request: RpcBridgeCommandRequest = { id, ...command };
			socket.write(`${JSON.stringify(request)}\n`);
		});
	});
}

export async function pingRpcBridge(
	agent: Pick<AgentSummary, "bridgeSocketPath" | "bridgeStatusFile">,
	timeoutMs = 1500,
): Promise<RpcBridgeCommandResponse | null> {
	const socketPath = getRpcBridgeSocketPath(agent);
	if (!socketPath) return null;
	try {
		return await sendRpcBridgeCommand(socketPath, { command: "ping" }, timeoutMs);
	} catch {
		return null;
	}
}
