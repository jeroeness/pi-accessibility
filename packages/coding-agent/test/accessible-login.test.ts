import type { AuthInteraction } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runLogin, runLogout } from "../src/modes/accessible/login.ts";
import type { CommandContext } from "../src/modes/accessible/types.ts";
import { createFakePrompter, createRecordingWriter } from "./accessible-test-support.ts";

interface FakeProvider {
	id: string;
	name: string;
	oauth?: boolean;
	/** `true` for an interactive API-key login, `"ambient"` for auth configured outside pi. */
	apiKey?: true | "ambient";
}

type LoginImpl = (providerId: string, type: "oauth" | "api_key", interaction: AuthInteraction) => Promise<void>;

/** Default login: an API-key flow asks for the key the way pi-ai's providers do. */
const defaultLogin: LoginImpl = async (_providerId, type, interaction) => {
	if (type === "api_key") {
		await interaction.prompt({ type: "secret", message: "Enter API key" });
	}
};

function makeLoginCtx(options: {
	providers?: FakeProvider[];
	stored?: Array<{ providerId: string; type: "oauth" | "api_key" }>;
	available?: Array<{ provider: string; id: string }>;
	prompterInputs?: string[];
	currentModel?: { provider: string; id: string } | undefined;
	loginImpl?: LoginImpl;
}) {
	const rec = createRecordingWriter();
	const fake = createFakePrompter(options.prompterInputs ?? []);
	const providers = (options.providers ?? []).map((provider) => ({
		id: provider.id,
		name: provider.name,
		auth: {
			...(provider.oauth ? { oauth: { name: `${provider.name} account` } } : {}),
			...(provider.apiKey
				? {
						apiKey: {
							name: `${provider.name} API key`,
							...(provider.apiKey === true ? { login: async () => ({ type: "api_key" }) } : {}),
						},
					}
				: {}),
		},
	}));
	const answers: string[] = [];
	const login = vi.fn(async (providerId: string, type: "oauth" | "api_key", interaction: AuthInteraction) => {
		const recordingInteraction: AuthInteraction = {
			...interaction,
			prompt: async (prompt) => {
				const answer = await interaction.prompt(prompt);
				answers.push(answer);
				return answer;
			},
		};
		await (options.loginImpl ?? defaultLogin)(providerId, type, recordingInteraction);
		return { type };
	});
	const logout = vi.fn().mockResolvedValue(undefined);
	const refresh = vi.fn().mockResolvedValue({ aborted: false, errors: new Map() });
	const setModel = vi.fn().mockResolvedValue(undefined);
	const modelRuntime = {
		getProviders: () => providers,
		getProvider: (id: string) => providers.find((provider) => provider.id === id),
		listCredentials: vi.fn().mockResolvedValue(options.stored ?? []),
		getAvailableSnapshot: () => options.available ?? [],
		login,
		logout,
		refresh,
	};
	const session = {
		model: "currentModel" in options ? options.currentModel : { provider: "x", id: "y" },
		modelRuntime,
		setModel,
		settingsManager: { getOrCreateDeviceId: () => "device-1" },
	};
	const ctx = {
		session,
		runtime: {},
		writer: rec.writer,
		prompter: fake.prompter,
		rebindSession: async () => {},
	} as unknown as CommandContext;

	return { ctx, rec, fake, login, logout, refresh, setModel, answers };
}

describe("runLogin (API key)", () => {
	it("logs in with an API key for the chosen provider", async () => {
		const { ctx, login, answers, rec } = makeLoginCtx({
			providers: [{ id: "openai", name: "OpenAI", apiKey: true }],
			prompterInputs: ["2", "1", "sk-test-123"],
		});
		await runLogin(ctx);
		expect(login).toHaveBeenCalledWith("openai", "api_key", expect.any(Object), expect.any(Object));
		expect(answers).toEqual(["sk-test-123"]);
		// The provider's prompt is spoken with closing punctuation.
		expect(rec.lines).toContain("Enter API key:");
		expect(rec.lines.join("\n")).toContain("Saved API key for OpenAI");
	});

	it("reads the API key without echo and says that typing is hidden", async () => {
		const { ctx, fake, answers } = makeLoginCtx({
			providers: [{ id: "openai", name: "OpenAI", apiKey: true }],
			prompterInputs: ["2", "1", "sk-test-123"],
		});
		await runLogin(ctx);
		expect(answers).toEqual(["sk-test-123"]);
		// Two provider/method selections, then the secret key question.
		expect(fake.options).toEqual([undefined, undefined, { secret: true }]);
		expect(fake.prompts[2]).toBe("(typing is hidden) > ");
	});

	it("cancels when no key is entered", async () => {
		const { ctx, rec } = makeLoginCtx({
			providers: [{ id: "openai", name: "OpenAI", apiKey: true }],
			prompterInputs: ["2", "1", "  "],
		});
		await runLogin(ctx);
		expect(rec.lines).toContain("Login cancelled.");
		expect(rec.lines.join("\n")).not.toContain("Saved API key");
	});

	it("points to the docs for auth configured outside pi", async () => {
		const { ctx, login, rec } = makeLoginCtx({
			providers: [{ id: "ambient-cloud", name: "Ambient Cloud", apiKey: "ambient" }],
			prompterInputs: ["2", "1"],
		});
		await runLogin(ctx);
		expect(login).not.toHaveBeenCalled();
		expect(rec.lines.join("\n")).toContain("Ambient Cloud API key is configured outside pi");
	});

	it("selects the provider's default model, persisted, when no model is active", async () => {
		const { ctx, setModel, refresh, rec } = makeLoginCtx({
			providers: [{ id: "openai", name: "OpenAI", apiKey: true }],
			available: [{ provider: "openai", id: "some-model" }],
			currentModel: undefined,
			prompterInputs: ["2", "1", "sk-test-123"],
		});
		await runLogin(ctx);
		expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ providers: ["openai"] }));
		expect(setModel).toHaveBeenCalledWith({ provider: "openai", id: "some-model" }, { persist: true });
		expect(rec.lines.join("\n")).toContain("Selected openai/some-model");
	});
});

describe("runLogin (subscription / OAuth)", () => {
	it("calls modelRuntime.login for the chosen OAuth provider", async () => {
		const { ctx, login, rec } = makeLoginCtx({
			providers: [{ id: "anthropic", name: "Anthropic", oauth: true }],
			prompterInputs: ["1", "1"],
		});
		await runLogin(ctx);
		expect(login).toHaveBeenCalledWith("anthropic", "oauth", expect.any(Object), expect.any(Object));
		expect(rec.lines.join("\n")).toContain("Logged in to Anthropic");
	});

	it("renders auth events (URL, device code) and answers prompts and selections from readline", async () => {
		let selectedId: string | undefined;
		const { ctx, rec, fake } = makeLoginCtx({
			providers: [{ id: "anthropic", name: "Anthropic", oauth: true }],
			prompterInputs: ["1", "1", "the-code", "2"],
			loginImpl: async (_id, _type, interaction) => {
				interaction.notify({
					type: "auth_url",
					url: "https://auth.example/login",
					instructions: "Authorize the app.",
				});
				interaction.notify({
					type: "device_code",
					userCode: "WXYZ-1234",
					verificationUri: "https://verify.example",
					expiresInSeconds: 600,
				});
				interaction.notify({ type: "progress", message: "exchanging code" });
				const code = await interaction.prompt({ type: "manual_code", message: "Paste the code:" });
				expect(code).toBe("the-code");
				selectedId = await interaction.prompt({
					type: "select",
					message: "Choose an account",
					options: [
						{ id: "acct-a", label: "Account A" },
						{ id: "acct-b", label: "Account B" },
					],
				});
			},
		});
		await runLogin(ctx);
		// A pasted code is not a secret: it stays visible so the user can check it.
		expect(fake.options.every((option) => option === undefined)).toBe(true);
		const transcript = rec.lines.join("\n");
		expect(transcript).toContain("https://auth.example/login");
		expect(transcript).toContain("WXYZ-1234");
		expect(transcript).toContain("[exchanging code]");
		expect(selectedId).toBe("acct-b");
	});
});

describe("runLogin edge cases", () => {
	it("cancels at the method selector", async () => {
		const { ctx, rec, login } = makeLoginCtx({ prompterInputs: [""] });
		await runLogin(ctx);
		expect(login).not.toHaveBeenCalled();
		expect(rec.lines).toContain("Login cancelled.");
	});

	it("reports when no subscription providers are available", async () => {
		const { ctx, rec } = makeLoginCtx({ providers: [], prompterInputs: ["1"] });
		await runLogin(ctx);
		expect(rec.lines).toContain("No subscription providers available.");
	});
});

describe("runLogout", () => {
	it("removes the selected stored credential", async () => {
		const { ctx, logout, rec } = makeLoginCtx({
			providers: [{ id: "anthropic", name: "Anthropic", oauth: true }],
			stored: [{ providerId: "anthropic", type: "oauth" }],
			prompterInputs: ["1"],
		});
		await runLogout(ctx);
		expect(logout).toHaveBeenCalledWith("anthropic", expect.any(Object));
		expect(rec.lines.join("\n")).toContain("Logged out of Anthropic");
	});

	it("reports when there is nothing to remove", async () => {
		const { ctx, logout, rec } = makeLoginCtx({ stored: [], prompterInputs: [] });
		await runLogout(ctx);
		expect(logout).not.toHaveBeenCalled();
		expect(rec.lines.join("\n")).toContain("No stored credentials to remove");
	});
});
