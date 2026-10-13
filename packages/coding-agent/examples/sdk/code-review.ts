/**
 * Parallel code review with 3 sub-agents.
 * Agent 1: code quality and architecture
 * Agent 2: security and correctness
 * Agent 3: performance and best practices
 */

import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();

const modelRuntime = await ModelRuntime.create();
const available = await modelRuntime.getAvailable();

// Prefer github-copilot sonnet, fall back to first available
const model = available.find((m) => m.provider === "github-copilot" && m.id === "claude-sonnet-4.5") ?? available[0];

if (!model) throw new Error("No models available. Configure a provider API key.");
console.log(`Using model: ${model.provider}/${model.id}\n`);

async function runReviewAgent(name: string, focus: string): Promise<string> {
	const { session } = await createAgentSession({
		cwd,
		model,
		modelRuntime,
		tools: ["read", "bash", "grep", "find", "ls"],
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
	});

	let output = "";

	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			output += event.assistantMessageEvent.delta;
		}
	});

	try {
		process.stderr.write(`[${name}] starting...\n`);
		await session.prompt(
			`You are performing a focused code review. Your focus area is: ${focus}.\n\n` +
				`Review the codebase in the current directory (${cwd}).\n` +
				`Start by listing the top-level files and directories, then read the most relevant source files for your focus area.\n` +
				`Write a concise review covering: what you found, specific issues or concerns, and concrete recommendations.\n` +
				`Keep your review under 400 words.`,
		);
		const err = session.agent.state.errorMessage;
		if (err) throw new Error(`Agent error: ${err}`);
		process.stderr.write(`[${name}] done.\n`);
	} finally {
		session.dispose();
	}

	return output;
}

console.log("Starting 3 parallel code review agents...\n");

const [quality, security, performance] = await Promise.all([
	runReviewAgent("Quality", "code quality, architecture, naming, structure, and maintainability"),
	runReviewAgent("Security", "security, correctness, error handling, input validation, and potential bugs"),
	runReviewAgent("Performance", "performance, efficiency, resource usage, and best practices"),
]);

console.log("=".repeat(60));
console.log("AGENT 1: Code Quality & Architecture");
console.log("=".repeat(60));
console.log(quality);

console.log(`\n${"=".repeat(60)}`);
console.log("AGENT 2: Security & Correctness");
console.log("=".repeat(60));
console.log(security);

console.log(`\n${"=".repeat(60)}`);
console.log("AGENT 3: Performance & Best Practices");
console.log("=".repeat(60));
console.log(performance);
