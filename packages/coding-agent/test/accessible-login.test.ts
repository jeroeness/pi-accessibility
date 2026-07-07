import { describe, expect, it, vi } from "vitest";
import { runLogin, runLogout } from "../src/modes/accessible/login.ts";
import type { CommandContext } from "../src/modes/accessible/types.ts";
import { createFakePrompter, createRecordingWriter } from "./accessible-test-support.ts";

const DISPLAY_NAMES: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI" };

function makeLoginCtx(options: {
	oauthProviders?: Array<{ id: string; name: string; usesCallbackServer?: boolean }>;
	models?: Array<{ provider: string }>;
	stored?: Record<string, { type: "oauth" | "api_key" }>;
	prompterInputs?: string[];
	currentModel?: { provider: string; id: string } | undefined;
	loginImpl?: (providerId: string, callbacks: any) => Promise<void>;
}) {
	const rec = createRecordingWriter();
	const fake = createFakePrompter(options.prompterInputs ?? []);
	const set = vi.fn();
	const logout = vi.fn();
	const login = vi.fn(options.loginImpl ?? (async () => {}));
	const refresh = vi.fn();
	const setModel = vi.fn().mockResolvedValue(undefined);
	const stored = options.stored ?? {};

	const authStorage = {
		getOAuthProviders: () => options.oauthProviders ?? [],
		list: () => Object.keys(stored),
		get: (id: string) => stored[id],
		set,
		logout,
		login,
	};
	const modelRegistry = {
		authStorage,
		getAll: () => options.models ?? [],
		getAvailable: () => [],
		getProviderDisplayName: (id: string) => DISPLAY_NAMES[id] ?? id,
		refresh,
	};
	const session = {
		model: "currentModel" in options ? options.currentModel : { provider: "x", id: "y" },
		modelRegistry,
		setModel,
	};
	const ctx = {
		session,
		runtime: {},
		writer: rec.writer,
		prompter: fake.prompter,
		rebindSession: async () => {},
	} as unknown as CommandContext;

	return { ctx, rec, set, logout, login, refresh, setModel };
}

describe("runLogin (API key)", () => {
	it("stores an API key for the chosen provider", async () => {
		const { ctx, set, rec } = makeLoginCtx({
			models: [{ provider: "openai" }],
			prompterInputs: ["2", "1", "sk-test-123"],
		});
		await runLogin(ctx);
		expect(set).toHaveBeenCalledWith("openai", { type: "api_key", key: "sk-test-123" });
		expect(rec.lines.join("\n")).toContain("Saved API key for OpenAI");
	});

	it("cancels when no key is entered", async () => {
		const { ctx, set } = makeLoginCtx({ models: [{ provider: "openai" }], prompterInputs: ["2", "1", "  "] });
		await runLogin(ctx);
		expect(set).not.toHaveBeenCalled();
	});
});

describe("runLogin (subscription / OAuth)", () => {
	it("calls authStorage.login for the chosen OAuth provider", async () => {
		const { ctx, login, rec } = makeLoginCtx({
			oauthProviders: [{ id: "anthropic", name: "Anthropic", usesCallbackServer: true }],
			prompterInputs: ["1", "1"],
		});
		await runLogin(ctx);
		expect(login).toHaveBeenCalledWith("anthropic", expect.any(Object));
		expect(rec.lines.join("\n")).toContain("Logged in to Anthropic");
	});

	it("renders OAuth callbacks (URL, device code) and feeds prompt/select from readline", async () => {
		let selectedId: string | undefined;
		const { ctx, rec } = makeLoginCtx({
			oauthProviders: [{ id: "anthropic", name: "Anthropic" }],
			prompterInputs: ["1", "1", "the-code", "2"],
			loginImpl: async (_id, cb) => {
				cb.onAuth({ url: "https://auth.example/login", instructions: "Authorize the app." });
				cb.onDeviceCode({
					userCode: "WXYZ-1234",
					verificationUri: "https://verify.example",
					expiresInSeconds: 600,
				});
				cb.onProgress("exchanging code");
				const code = await cb.onPrompt({ message: "Paste the code:" });
				expect(code).toBe("the-code");
				selectedId = await cb.onSelect({
					message: "Choose an account",
					options: [
						{ id: "acct-a", label: "Account A" },
						{ id: "acct-b", label: "Account B" },
					],
				});
			},
		});
		await runLogin(ctx);
		const transcript = rec.lines.join("\n");
		expect(transcript).toContain("https://auth.example/login");
		expect(transcript).toContain("WXYZ-1234");
		expect(transcript).toContain("[exchanging code]");
		expect(selectedId).toBe("acct-b");
	});
});

describe("runLogin edge cases", () => {
	it("cancels at the method selector", async () => {
		const { ctx, rec, login, set } = makeLoginCtx({ prompterInputs: [""] });
		await runLogin(ctx);
		expect(login).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
		expect(rec.lines).toContain("Login cancelled.");
	});

	it("reports when no subscription providers are available", async () => {
		const { ctx, rec } = makeLoginCtx({ oauthProviders: [], prompterInputs: ["1"] });
		await runLogin(ctx);
		expect(rec.lines).toContain("No subscription providers available.");
	});
});

describe("runLogout", () => {
	it("removes the selected stored credential", async () => {
		const { ctx, logout, refresh, rec } = makeLoginCtx({
			stored: { anthropic: { type: "oauth" } },
			prompterInputs: ["1"],
		});
		await runLogout(ctx);
		expect(logout).toHaveBeenCalledWith("anthropic");
		expect(refresh).toHaveBeenCalled();
		expect(rec.lines.join("\n")).toContain("Logged out of Anthropic");
	});

	it("reports when there is nothing to remove", async () => {
		const { ctx, logout, rec } = makeLoginCtx({ stored: {}, prompterInputs: [] });
		await runLogout(ctx);
		expect(logout).not.toHaveBeenCalled();
		expect(rec.lines.join("\n")).toContain("No stored credentials to remove");
	});
});
