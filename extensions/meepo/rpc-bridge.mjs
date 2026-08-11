#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

function parseArgs(argv) {
	const result = { configPath: null };
	for (let index = 2; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--config") {
			result.configPath = argv[index + 1] ?? null;
			index += 1;
		}
	}
	if (!result.configPath) {
		throw new Error("Usage: rpc-bridge.mjs --config /path/to/bridge-config.json");
	}
	return result;
}

function readJson(pathname) {
	return JSON.parse(fs.readFileSync(pathname, "utf8"));
}

function writeJson(pathname, value) {
	const tempPath = `${pathname}.${process.pid}.${randomUUID()}.tmp`;
	fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
	fs.renameSync(tempPath, pathname);
}

function appendJsonLine(pathname, value) {
	fs.appendFileSync(pathname, `${JSON.stringify(value)}\n`);
}

function ensureParentDir(pathname) {
	fs.mkdirSync(path.dirname(pathname), { recursive: true });
}

function createJsonlParser(onLine) {
	let buffer = "";
	return (chunk) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			onLine(line);
		}
	};
}

function safeJsonParse(line) {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function shellText(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

function now() {
	return Date.now();
}

function hasOwn(value, key) {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function truncateText(value, maxLength = 400) {
	const singleLine = String(value ?? "").replace(/\s+/g, " ").trim();
	if (!singleLine) return null;
	if (singleLine.length <= maxLength) return singleLine;
	return `${singleLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function getAssistantText(message) {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

const CHILD_RPC_TIMEOUT_MS = 15000;
const SHUTDOWN_GRACE_MS = 3000;
const UI_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

function main() {
	const { configPath } = parseArgs(process.argv);
	const config = readJson(configPath);
	const logFile = config.bridgeLogFile;
	const bridgeEventsFile = config.bridgeEventsFile;
	const debugLogFile = config.debugLogFile;
	const bridgeStatusFile = config.bridgeStatusFile;
	const bridgePidFile = config.bridgePidFile;
	const socketPath = config.bridgeSocketPath;
	const pendingResponses = new Map();
	const activeSockets = new Set();
	let child = null;
	let server = null;
	let shuttingDown = false;
	let assistantStreaming = false;
	let childExited = false;
	const status = {
		agentId: config.agentId,
		transportKind: "rpc_bridge",
		transportState: "launching",
		updatedAt: now(),
		bridgePid: process.pid,
		childPid: null,
		socketPath,
		connectedAt: null,
		lastError: null,
		lastEventType: null,
		isStreaming: false,
		pendingRequests: 0,
	};

	ensureParentDir(logFile);
	fs.writeFileSync(logFile, "");
	fs.writeFileSync(bridgeEventsFile, "");
	fs.writeFileSync(bridgePidFile, `${process.pid}\n`);
	if (fs.existsSync(socketPath)) {
		try {
			fs.unlinkSync(socketPath);
		} catch {
			// Ignore stale socket cleanup errors.
		}
	}

	const writeStatus = (patch = {}) => {
		Object.assign(status, patch, { updatedAt: patch.updatedAt ?? now(), pendingRequests: pendingResponses.size });
		writeJson(bridgeStatusFile, status);
	};

	const chooseNormalizedState = (existingState, requestedState) => {
		if (!requestedState) return existingState ?? "launching";
		if (["done", "error", "stopped"].includes(existingState ?? "") && ["launching", "running"].includes(requestedState)) {
			return existingState;
		}
		if (existingState === "done" && requestedState === "stopped") return existingState;
		if (existingState === "error" && requestedState === "stopped") return existingState;
		return requestedState;
	};

	const readNormalizedRuntimeStatus = () => {
		if (!config.latestStatusFile || !fs.existsSync(config.latestStatusFile)) return null;
		try {
			const parsed = JSON.parse(fs.readFileSync(config.latestStatusFile, "utf8"));
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch {
			return null;
		}
	};

	const writeNormalizedRuntimeStatus = (patch = {}) => {
		const existing = readNormalizedRuntimeStatus() ?? {};
		const next = {
			...existing,
			agentId: config.agentId,
			profile: existing.profile ?? config.childEnv?.PI_TMUX_AGENTS_PROFILE ?? null,
			state: chooseNormalizedState(existing.state, patch.state),
			updatedAt: patch.updatedAt ?? now(),
			lastToolName: hasOwn(patch, "lastToolName") ? patch.lastToolName ?? null : existing.lastToolName ?? null,
			lastAssistantPreview: hasOwn(patch, "lastAssistantPreview") ? patch.lastAssistantPreview ?? null : existing.lastAssistantPreview ?? null,
			lastError: hasOwn(patch, "lastError") ? patch.lastError ?? null : existing.lastError ?? null,
			finalSummary: hasOwn(patch, "finalSummary") ? patch.finalSummary ?? null : existing.finalSummary ?? null,
			finishedAt: hasOwn(patch, "finishedAt") ? patch.finishedAt ?? null : existing.finishedAt ?? null,
			source: "rpc_bridge",
			transportKind: "rpc_bridge",
			transportState: status.transportState,
			downwardDeliveryMode: "rpc_bridge",
		};
		writeJson(config.latestStatusFile, next);
	};

	const log = (message, extra) => {
		const line = `[${new Date().toISOString()}] ${message}`;
		fs.appendFileSync(logFile, `${line}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`);
		fs.appendFileSync(debugLogFile, `${line}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`);
	};

	const render = (text = "") => {
		process.stdout.write(text);
	};

	const renderLine = (text = "") => {
		process.stdout.write(`${text}\n`);
	};

	const recordBridgeEvent = (eventType, payload = {}) => {
		appendJsonLine(bridgeEventsFile, {
			id: randomUUID(),
			eventType,
			payload,
			createdAt: now(),
		});
	};

	const cleanup = () => {
		if (server) {
			try {
				server.close();
			} catch {
				// Ignore close errors.
			}
		}
		for (const socket of activeSockets) {
			try {
				socket.destroy();
			} catch {
				// Ignore socket close errors.
			}
		}
		if (fs.existsSync(socketPath)) {
			try {
				fs.unlinkSync(socketPath);
			} catch {
				// Ignore unlink errors.
			}
		}
	};

	const failPending = (errorMessage) => {
		for (const [id, pending] of pendingResponses.entries()) {
			pending.reject(new Error(errorMessage));
			pendingResponses.delete(id);
		}
	};

	const sendRpcCommand = (command, timeoutMs = CHILD_RPC_TIMEOUT_MS) => {
		if (!child || !child.stdin || childExited) {
			return Promise.reject(new Error("Child RPC session is not available."));
		}
		const id = command.id ?? randomUUID();
		const request = { ...command, id };
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				pendingResponses.delete(id);
				writeStatus({ lastError: `Child RPC command timed out after ${timeoutMs}ms.` });
				reject(new Error(`Child RPC command timed out after ${timeoutMs}ms.`));
			}, Math.max(1, timeoutMs));
			pendingResponses.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolvePromise(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			writeStatus();
			try {
				child.stdin.write(`${JSON.stringify(request)}\n`);
			} catch (error) {
				clearTimeout(timer);
				pendingResponses.delete(id);
				writeStatus();
				reject(error);
			}
		});
	};

	const mirrorEvent = (event) => {
		if (!event || typeof event !== "object") return;
		if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
			assistantStreaming = true;
			writeStatus({ isStreaming: true, lastEventType: event.type, transportState: status.transportState === "launching" ? "live" : status.transportState });
			render(event.assistantMessageEvent.delta ?? "");
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			if (assistantStreaming) {
				assistantStreaming = false;
				writeStatus({ isStreaming: false, lastEventType: event.type });
				renderLine("");
			}
			const assistantText = getAssistantText(event.message);
			writeNormalizedRuntimeStatus({
				state: "running",
				lastAssistantPreview: truncateText(assistantText),
				lastError: event.message?.stopReason === "error" ? truncateText(event.message?.errorMessage || assistantText || "Assistant error.") : null,
			});
			const stopReason = shellText(event.message?.stopReason);
			if (stopReason && stopReason !== "end_turn") {
				renderLine(`[assistant:${stopReason}]`);
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			writeStatus({ lastEventType: event.type });
			writeNormalizedRuntimeStatus({ state: "running", lastToolName: event.toolName ?? null, lastError: null });
			renderLine(`\n$ ${event.toolName}`);
			return;
		}
		if (event.type === "tool_execution_end") {
			writeStatus({ lastEventType: event.type });
			writeNormalizedRuntimeStatus({
				state: "running",
				lastToolName: event.toolName ?? null,
				lastError: event.isError ? truncateText(`${event.toolName} failed`) : null,
			});
			if (event.isError) renderLine(`! ${event.toolName} failed`);
			return;
		}
		if (event.type === "agent_start") {
			writeStatus({ transportState: "live", connectedAt: status.connectedAt ?? now(), lastEventType: event.type });
			writeNormalizedRuntimeStatus({ state: "running", lastError: null });
			renderLine(`[agent] started ${config.agentId}`);
			return;
		}
		if (event.type === "agent_end") {
			const lastAssistantMessage = Array.isArray(event.messages)
				? [...event.messages].reverse().find((message) => message?.role === "assistant")
				: null;
			const assistantText = getAssistantText(lastAssistantMessage);
			const terminalState = lastAssistantMessage?.stopReason === "error" ? "error" : "stopped";
			writeStatus({ lastEventType: event.type, isStreaming: false });
			writeNormalizedRuntimeStatus({
				state: terminalState,
				lastAssistantPreview: truncateText(assistantText) ?? undefined,
				finalSummary: terminalState === "stopped" ? truncateText(assistantText) ?? undefined : undefined,
				lastError:
					terminalState === "error"
						? truncateText(lastAssistantMessage?.errorMessage || assistantText || "Subagent exited with an error.")
						: null,
				finishedAt: now(),
			});
			renderLine(`\n[agent] finished ${config.agentId}`);
			return;
		}
		if (event.type === "queue_update") {
			writeStatus({ lastEventType: event.type });
			return;
		}
		if (event.type === "extension_ui_request") {
			writeStatus({ lastEventType: event.type });
			log("extension_ui_request", { method: event.method, title: event.title });
			if (typeof event.id === "string" && UI_DIALOG_METHODS.has(event.method)) {
				try {
					child?.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
					recordBridgeEvent("extension_ui_auto_cancelled", { id: event.id, method: event.method, title: event.title ?? null });
					log("extension_ui_auto_cancelled", { id: event.id, method: event.method });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					recordBridgeEvent("extension_ui_auto_cancel_failed", { id: event.id, method: event.method, error: message });
					log("extension_ui_auto_cancel_failed", { id: event.id, method: event.method, error: message });
				}
			}
			return;
		}
		if (typeof event.type === "string") {
			writeStatus({ lastEventType: event.type });
		}
	};

	const handleChildLine = (line) => {
		const payload = safeJsonParse(line);
		if (!payload) {
			log("unparsed_child_output", { line });
			return;
		}
		recordBridgeEvent("child_stdout", payload);
		if (payload.type === "response" && typeof payload.id === "string") {
			const pending = pendingResponses.get(payload.id);
			if (pending) {
				pendingResponses.delete(payload.id);
				writeStatus();
				pending.resolve(payload);
				return;
			}
		}
		mirrorEvent(payload);
	};

	const handleSocketConnection = (socket) => {
		activeSockets.add(socket);
		const parser = createJsonlParser(async (line) => {
			const request = safeJsonParse(line);
			if (!request || typeof request.id !== "string" || typeof request.command !== "string") {
				socket.write(`${JSON.stringify({ id: request?.id ?? randomUUID(), success: false, error: "Invalid bridge request." })}\n`);
				return;
			}
			const respond = (response) => socket.write(`${JSON.stringify({ id: request.id, ...response })}\n`);
			try {
				if (request.command === "ping") {
					respond({ success: true, data: status });
					return;
				}
				if (request.command === "get_state") {
					const response = await sendRpcCommand({ type: "get_state" });
					respond({ success: response.success !== false, data: response.data ?? null, error: response.error ?? undefined });
					return;
				}
				if (request.command === "abort") {
					const response = await sendRpcCommand({ type: "abort" });
					respond({ success: response.success !== false, data: response.data ?? null, error: response.error ?? undefined });
					return;
				}
				if (request.command === "prompt") {
					const response = await sendRpcCommand({ type: "prompt", message: request.message ?? "", streamingBehavior: request.streamingBehavior, images: request.images });
					respond({ success: response.success !== false, data: response.data ?? null, error: response.error ?? undefined });
					return;
				}
				if (request.command === "steer") {
					const response = await sendRpcCommand({ type: "steer", message: request.message ?? "", images: request.images });
					respond({ success: response.success !== false, data: response.data ?? null, error: response.error ?? undefined });
					return;
				}
				if (request.command === "follow_up") {
					const response = await sendRpcCommand({ type: "follow_up", message: request.message ?? "", images: request.images });
					respond({ success: response.success !== false, data: response.data ?? null, error: response.error ?? undefined });
					return;
				}
				respond({ success: false, error: `Unsupported bridge command: ${request.command}` });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				writeStatus({ lastError: message });
				respond({ success: false, error: message });
			}
		});
		socket.on("data", parser);
		socket.on("close", () => activeSockets.delete(socket));
		socket.on("error", () => activeSockets.delete(socket));
	};

	server = net.createServer(handleSocketConnection);
	server.on("error", (error) => {
		const message = error instanceof Error ? error.message : String(error);
		writeStatus({ transportState: "error", lastError: message, isStreaming: false });
		writeNormalizedRuntimeStatus({ state: "error", lastError: truncateText(message), finishedAt: now() });
		recordBridgeEvent("bridge_server_error", { error: message, socketPath });
		log("bridge_server_error", { error: message, socketPath });
		renderLine(`[bridge:error] ${message}`);
		failPending(message);
		cleanup();
		process.exit(1);
	});
	server.listen(socketPath, () => {
		writeStatus({ transportState: "listening" });
		writeNormalizedRuntimeStatus({ state: "launching" });
		recordBridgeEvent("bridge_listening", { socketPath, bridgePid: process.pid });
		log("bridge_listening", { socketPath, bridgePid: process.pid });
		renderLine(`[bridge] listening ${socketPath}`);
	});

	child = spawn(config.piCommand, config.piArgs, {
		cwd: config.spawnCwd,
		env: { ...process.env, ...(config.childEnv ?? {}) },
		stdio: ["pipe", "pipe", "pipe"],
		shell: false,
	});
	writeStatus({ childPid: child.pid ?? null });
	recordBridgeEvent("child_spawned", { childPid: child.pid ?? null, command: config.piCommand, args: config.piArgs });
	log("child_spawned", { childPid: child.pid ?? null, command: config.piCommand, args: config.piArgs });
	renderLine(`[bridge] child spawned ${child.pid ?? "?"}`);

	child.stdout.on("data", createJsonlParser(handleChildLine));
	child.stderr.on("data", (chunk) => {
		const text = chunk.toString();
		log("child_stderr", { text: shellText(text) });
		renderLine(`[pi stderr] ${shellText(text)}`);
	});
	child.on("error", (error) => {
		const message = error instanceof Error ? error.message : String(error);
		writeStatus({ transportState: "error", lastError: message, isStreaming: false });
		writeNormalizedRuntimeStatus({ state: "error", lastError: truncateText(message), finishedAt: now() });
		recordBridgeEvent("child_error", { error: message });
		log("child_error", { error: message });
		renderLine(`[bridge:error] ${message}`);
		failPending(message);
	});
	child.on("close", (code, signal) => {
		childExited = true;
		const gracefulSignals = new Set(["SIGINT", "SIGTERM"]);
		const stoppedGracefully = code === 0 || Boolean(signal && gracefulSignals.has(signal)) || (shuttingDown && code === 130);
		const transportState = stoppedGracefully ? "stopped" : "error";
		const lastError = transportState === "error" ? `Child RPC process exited with code ${code ?? "?"}${signal ? ` signal ${signal}` : ""}.` : null;
		writeStatus({ transportState, lastError, isStreaming: false });
		writeNormalizedRuntimeStatus({
			state: transportState === "error" ? "error" : "stopped",
			lastError: transportState === "error" ? truncateText(lastError) : null,
			finishedAt: now(),
		});
		recordBridgeEvent("child_exit", { code: code ?? null, signal: signal ?? null, transportState });
		log("child_exit", { code: code ?? null, signal: signal ?? null, transportState });
		renderLine(`\n[bridge] child exited ${code ?? "?"}${signal ? ` ${signal}` : ""}`);
		failPending(lastError ?? "Child RPC process stopped.");
		setTimeout(() => {
			cleanup();
			process.exit(transportState === "error" ? 1 : 0);
		}, 25);
	});

	const forwardSignal = (signalName) => {
		if (shuttingDown) return;
		shuttingDown = true;
		writeStatus({ transportState: "stopped", lastError: signalName, isStreaming: false });
		writeNormalizedRuntimeStatus({ state: "stopped", lastError: signalName, finishedAt: now() });
		recordBridgeEvent("bridge_signal", { signal: signalName });
		log("bridge_signal", { signal: signalName });
		if (child && !childExited) {
			try {
				child.kill(signalName);
			} catch {
				// Ignore kill errors.
			}
			setTimeout(() => {
				if (childExited) return;
				try {
					child.kill("SIGKILL");
				} catch {
					// Ignore kill errors.
				}
				cleanup();
				process.exit(0);
			}, SHUTDOWN_GRACE_MS);
			return;
		}
		cleanup();
		process.exit(0);
	};

	process.on("SIGINT", () => forwardSignal("SIGINT"));
	process.on("SIGTERM", () => forwardSignal("SIGTERM"));
	process.on("exit", cleanup);

	setTimeout(async () => {
		try {
			const promptText = fs.readFileSync(config.taskFile, "utf8");
			const response = await sendRpcCommand({ type: "prompt", message: promptText });
			if (response.success === false) {
				const message = response.error ?? "Initial prompt rejected.";
				writeStatus({ transportState: "error", lastError: message });
				writeNormalizedRuntimeStatus({ state: "error", lastError: truncateText(message), finishedAt: now() });
				recordBridgeEvent("initial_prompt_failed", { error: message });
				log("initial_prompt_failed", { error: message });
				renderLine(`[bridge:error] ${message}`);
			} else {
				writeStatus({ transportState: "live", connectedAt: now(), lastError: null });
				writeNormalizedRuntimeStatus({ lastError: null });
				recordBridgeEvent("initial_prompt_sent", { taskFile: config.taskFile });
				log("initial_prompt_sent", { taskFile: config.taskFile });
				renderLine(`[bridge] initial prompt sent`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			writeStatus({ transportState: "error", lastError: message });
			writeNormalizedRuntimeStatus({ state: "error", lastError: truncateText(message), finishedAt: now() });
			recordBridgeEvent("initial_prompt_error", { error: message });
			log("initial_prompt_error", { error: message });
			renderLine(`[bridge:error] ${message}`);
		}
	}, 150);

	writeStatus();
	writeNormalizedRuntimeStatus({
		state: "launching",
		lastToolName: null,
		lastAssistantPreview: null,
		lastError: null,
		finalSummary: null,
		finishedAt: null,
	});
	recordBridgeEvent("bridge_started", { configPath, bridgePid: process.pid });
	log("bridge_started", { configPath, bridgePid: process.pid });
	renderLine(`[bridge] starting ${config.agentId}`);
}

main();
