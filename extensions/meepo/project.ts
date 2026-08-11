import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export function getProjectKey(cwd: string): string {
	const resolvedCwd = resolve(cwd);
	try {
		const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: resolvedCwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (gitRoot) {
			return `git:${resolve(gitRoot)}`;
		}
	} catch {
		// Fall back to the current working directory when not inside a git repo.
	}
	return `dir:${resolvedCwd}`;
}
