/**
 * `/token quota` for accessible mode.
 *
 * Reports the remaining GitHub Copilot premium-request quota for the signed-in
 * subscription. Uses the same internal endpoint the official editor clients use
 * (`GET https://api.github.com/copilot_internal/user`), authenticated with the
 * stored GitHub token (the `refresh` field of the github-copilot OAuth
 * credential). This endpoint is not part of GitHub's documented public REST API,
 * so the shape may change; failures degrade to a plain message.
 */

import type { CommandContext } from "./types.ts";

const GITHUB_COPILOT_PROVIDER_ID = "github-copilot";

/** Headers that identify the request as an editor Copilot client. */
const COPILOT_USER_HEADERS = {
	Accept: "application/json",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"X-GitHub-Api-Version": "2025-04-01",
} as const;

interface QuotaDetail {
	entitlement: number;
	overage_count: number;
	overage_permitted: boolean;
	percent_remaining: number;
	quota_id: string;
	quota_remaining: number;
	remaining: number;
	unlimited: boolean;
}

interface QuotaSnapshots {
	chat?: QuotaDetail;
	completions?: QuotaDetail;
	premium_interactions?: QuotaDetail;
}

interface CopilotUsageResponse {
	copilot_plan?: string;
	quota_reset_date?: string;
	quota_snapshots?: QuotaSnapshots;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Derive the REST API host from an optional enterprise domain. */
function apiBaseUrl(enterpriseUrl: unknown): string {
	if (typeof enterpriseUrl === "string" && enterpriseUrl.trim()) {
		try {
			const host = enterpriseUrl.includes("://")
				? new URL(enterpriseUrl).hostname
				: new URL(`https://${enterpriseUrl}`).hostname;
			if (host) return `https://api.${host}`;
		} catch {
			// Fall through to the default host below.
		}
	}
	return "https://api.github.com";
}

/** Round a percentage to a whole number for speech. */
function percent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

/** One screen-reader line describing a single quota bucket. */
function quotaLine(label: string, detail: QuotaDetail | undefined): string | undefined {
	if (!detail) return undefined;
	if (detail.unlimited) {
		return `${label}: unlimited.`;
	}
	const base = `${label}: ${detail.remaining} of ${detail.entitlement} remaining (${percent(detail.percent_remaining)} percent).`;
	if (detail.overage_count > 0) {
		return `${base} Overage used: ${detail.overage_count}.`;
	}
	return base;
}

/** Run `/token quota`: fetch and print the Copilot premium-request quota. */
export async function handleTokenQuota(ctx: CommandContext): Promise<void> {
	const credential = ctx.session.modelRegistry.authStorage.get(GITHUB_COPILOT_PROVIDER_ID);
	if (!credential || credential.type !== "oauth") {
		ctx.writer.line("Not signed in to GitHub Copilot. Use /login and choose GitHub Copilot first.");
		return;
	}

	const githubToken = credential.refresh;
	if (!githubToken) {
		ctx.writer.line("No GitHub token stored for Copilot. Sign in again with /login.");
		return;
	}

	const url = `${apiBaseUrl(credential.enterpriseUrl)}/copilot_internal/user`;

	let raw: unknown;
	try {
		const response = await fetch(url, {
			headers: {
				...COPILOT_USER_HEADERS,
				Authorization: `token ${githubToken}`,
			},
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) {
			ctx.writer.error(`Could not read quota: ${response.status} ${response.statusText}.`);
			return;
		}
		raw = await response.json();
	} catch (error: unknown) {
		ctx.writer.error(`Could not read quota: ${error instanceof Error ? error.message : String(error)}.`);
		return;
	}

	const data = asRecord(raw) as CopilotUsageResponse | undefined;
	if (!data) {
		ctx.writer.error("Could not read quota: unexpected response.");
		return;
	}

	if (data.copilot_plan) {
		ctx.writer.line(`Copilot plan: ${data.copilot_plan}.`);
	}

	const snapshots = data.quota_snapshots ?? {};
	const lines = [
		quotaLine("Premium requests", snapshots.premium_interactions),
		quotaLine("Chat", snapshots.chat),
		quotaLine("Completions", snapshots.completions),
	].filter((line): line is string => line !== undefined);

	if (lines.length === 0) {
		ctx.writer.line("No quota information was returned for this account.");
	} else {
		for (const line of lines) {
			ctx.writer.line(line);
		}
	}

	if (data.quota_reset_date) {
		ctx.writer.line(`Quota resets on ${data.quota_reset_date}.`);
	}
}
