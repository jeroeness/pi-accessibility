/**
 * Text-based `/login` and `/logout` for accessible mode.
 *
 * Reuses the same auth logic as the TUI (`authStorage.login()` for subscriptions /
 * OAuth, `authStorage.set()` for API keys), but drives every interaction point
 * through readline text prompts instead of TUI dialogs.
 */

import type { Model } from "@earendil-works/pi-ai";
import { getProviders } from "@earendil-works/pi-ai/compat";
import type { OAuthLoginCallbacks, OAuthProviderId } from "@earendil-works/pi-ai/oauth";
import { getAuthPath } from "../../config.ts";
import { defaultModelPerProvider } from "../../core/model-resolver.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../core/provider-display-names.ts";
import type { CommandContext } from "./types.ts";

const BEDROCK_PROVIDER_ID = "amazon-bedrock";
const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

interface ProviderOption {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
}

/** Mirrors interactive mode: which providers can be logged into with an API key. */
function isApiKeyLoginProvider(providerId: string, oauthProviderIds: ReadonlySet<string>): boolean {
	if (BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId]) {
		return true;
	}
	if (BUILT_IN_MODEL_PROVIDERS.has(providerId)) {
		return false;
	}
	return !oauthProviderIds.has(providerId);
}

/** Print a numbered list and read a 1-based choice; returns a 0-based index or undefined. */
async function selectNumber(ctx: CommandContext, title: string, labels: string[]): Promise<number | undefined> {
	ctx.writer.line(title);
	labels.forEach((label, index) => {
		ctx.writer.line(`  ${index + 1}. ${label}`);
	});
	const answer = (await ctx.prompter.question("Enter a number (Enter to cancel): ")).trim();
	if (answer === "" || answer.toLowerCase() === "q") {
		return undefined;
	}
	const choice = Number.parseInt(answer, 10);
	if (Number.isNaN(choice) || choice < 1 || choice > labels.length) {
		return undefined;
	}
	return choice - 1;
}

function getLoginProviderOptions(ctx: CommandContext, authType: "oauth" | "api_key"): ProviderOption[] {
	const { authStorage } = ctx.session.modelRegistry;
	const oauthProviders = authStorage.getOAuthProviders();
	const oauthIds = new Set(oauthProviders.map((provider) => provider.id));

	const options: ProviderOption[] = oauthProviders.map((provider) => ({
		id: provider.id,
		name: provider.name,
		authType: "oauth" as const,
	}));

	const modelProviders = new Set(ctx.session.modelRegistry.getAll().map((model) => model.provider));
	for (const providerId of modelProviders) {
		if (!isApiKeyLoginProvider(providerId, oauthIds)) {
			continue;
		}
		options.push({
			id: providerId,
			name: ctx.session.modelRegistry.getProviderDisplayName(providerId),
			authType: "api_key",
		});
	}

	return options.filter((option) => option.authType === authType).sort((a, b) => a.name.localeCompare(b.name));
}

async function completeAuth(
	ctx: CommandContext,
	providerId: string,
	providerName: string,
	authType: "oauth" | "api_key",
): Promise<void> {
	ctx.session.modelRegistry.refresh();
	const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

	let selected: Model<any> | undefined;
	if (!ctx.session.model) {
		const providerModels = ctx.session.modelRegistry.getAvailable().filter((model) => model.provider === providerId);
		const defaultId = defaultModelPerProvider[providerId as keyof typeof defaultModelPerProvider];
		selected = providerModels.find((model) => model.id === defaultId) ?? providerModels[0];
		if (selected) {
			try {
				await ctx.session.setModel(selected);
			} catch {
				selected = undefined;
			}
		}
	}

	if (selected) {
		ctx.writer.line(
			`${actionLabel}. Selected ${selected.provider}/${selected.id}. Credentials saved to ${getAuthPath()}.`,
		);
	} else {
		ctx.writer.line(`${actionLabel}. Credentials saved to ${getAuthPath()}. Use /model to select a model.`);
	}
}

async function doApiKeyLogin(ctx: CommandContext, providerId: string, providerName: string): Promise<void> {
	const apiKey = (await ctx.prompter.question(`Enter API key for ${providerName}: `)).trim();
	if (!apiKey) {
		ctx.writer.line("No API key entered; login cancelled.");
		return;
	}
	ctx.session.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });
	await completeAuth(ctx, providerId, providerName, "api_key");
}

async function doOAuthLogin(ctx: CommandContext, providerId: string, providerName: string): Promise<void> {
	const callbacks: OAuthLoginCallbacks = {
		onAuth: (info) => {
			ctx.writer.line("Open this URL in a browser to authenticate:");
			ctx.writer.line(info.url);
			if (info.instructions) {
				ctx.writer.line(info.instructions);
			}
		},
		onDeviceCode: (info) => {
			ctx.writer.line(`Go to ${info.verificationUri} and enter this code: ${info.userCode}`);
			if (info.expiresInSeconds) {
				ctx.writer.line(`The code expires in about ${Math.round(info.expiresInSeconds / 60)} minute(s).`);
			}
			ctx.writer.line("Waiting for authentication…");
		},
		onPrompt: async (prompt) => {
			ctx.writer.line(prompt.message);
			return ctx.prompter.question(prompt.placeholder ? `(${prompt.placeholder}) ` : "> ");
		},
		onProgress: (message) => {
			ctx.writer.line(`[${message}]`);
		},
		onSelect: async (prompt) => {
			const index = await selectNumber(
				ctx,
				prompt.message,
				prompt.options.map((option) => option.label),
			);
			return index === undefined ? undefined : prompt.options[index].id;
		},
	};

	await ctx.session.modelRegistry.authStorage.login(providerId as OAuthProviderId, callbacks);
	await completeAuth(ctx, providerId, providerName, "oauth");
}

/** Run the `/login` flow: choose subscription vs API key, pick a provider, authenticate. */
export async function runLogin(ctx: CommandContext): Promise<void> {
	const method = await selectNumber(ctx, "Select authentication method:", ["Use a subscription", "Use an API key"]);
	if (method === undefined) {
		ctx.writer.line("Login cancelled.");
		return;
	}

	const authType = method === 0 ? "oauth" : "api_key";
	const options = getLoginProviderOptions(ctx, authType);
	if (options.length === 0) {
		ctx.writer.line(
			authType === "oauth" ? "No subscription providers available." : "No API key providers available.",
		);
		return;
	}

	const index = await selectNumber(
		ctx,
		authType === "oauth" ? "Select a subscription provider:" : "Select an API key provider:",
		options.map((option) => option.name),
	);
	if (index === undefined) {
		ctx.writer.line("Login cancelled.");
		return;
	}

	const provider = options[index];
	try {
		if (provider.authType === "oauth") {
			await doOAuthLogin(ctx, provider.id, provider.name);
		} else if (provider.id === BEDROCK_PROVIDER_ID) {
			ctx.writer.line("Amazon Bedrock uses AWS credentials, not a single API key.");
			ctx.writer.line("Configure an AWS profile, IAM keys, a bearer token, or a role. See docs/providers.md.");
		} else {
			await doApiKeyLogin(ctx, provider.id, provider.name);
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === "Login cancelled") {
			ctx.writer.line("Login cancelled.");
		} else {
			ctx.writer.error(`Login failed for ${provider.name}: ${message}`);
		}
	}
}

/** Run the `/logout` flow: pick a stored credential and remove it. */
export async function runLogout(ctx: CommandContext): Promise<void> {
	const { authStorage } = ctx.session.modelRegistry;
	const options: ProviderOption[] = [];
	for (const providerId of authStorage.list()) {
		const credential = authStorage.get(providerId);
		if (!credential) {
			continue;
		}
		options.push({
			id: providerId,
			name: ctx.session.modelRegistry.getProviderDisplayName(providerId),
			authType: credential.type,
		});
	}
	options.sort((a, b) => a.name.localeCompare(b.name));

	if (options.length === 0) {
		ctx.writer.line(
			"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json are unchanged.",
		);
		return;
	}

	const index = await selectNumber(
		ctx,
		"Select a provider to log out of:",
		options.map((option) => option.name),
	);
	if (index === undefined) {
		ctx.writer.line("Logout cancelled.");
		return;
	}

	const provider = options[index];
	try {
		authStorage.logout(provider.id);
		ctx.session.modelRegistry.refresh();
		ctx.writer.line(
			provider.authType === "oauth"
				? `Logged out of ${provider.name}.`
				: `Removed stored API key for ${provider.name}. Environment variables and models.json are unchanged.`,
		);
	} catch (error: unknown) {
		ctx.writer.error(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
