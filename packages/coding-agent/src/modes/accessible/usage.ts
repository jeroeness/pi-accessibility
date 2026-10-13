/**
 * `/usage` (and its hidden `/token` synonym) for accessible mode.
 *
 * Reports the remaining GitHub Copilot premium-request quota for the signed-in
 * subscription. Uses the same internal endpoint the official editor clients use
 * (`GET https://api.github.com/copilot_internal/user`), authenticated with the
 * stored GitHub token (the `refresh` field of the github-copilot OAuth
 * credential). This endpoint is not part of GitHub's documented public REST API,
 * so the shape may change; failures degrade to a plain message.
 */

import type { Credential } from "@earendil-works/pi-ai";
import { getAuthPath } from "../../config.ts";
import { readStoredCredential } from "../../core/auth-storage.ts";
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

/** One `quota_snapshots` bucket, after validation. Fields absent from the response stay undefined. */
interface QuotaDetail {
	unlimited: boolean;
	remaining?: number;
	entitlement?: number;
	percentRemaining?: number;
	overageCount?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** A finite number, or undefined when the field is missing or not numeric. */
function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A non-blank string, trimmed, or undefined. */
function asText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Validate one quota bucket. The endpoint is undocumented, so no field is trusted: a
 * bucket that arrives without usable numbers is reported as unavailable rather than
 * spoken as "undefined of undefined" or "NaN percent".
 */
function readQuota(value: unknown): QuotaDetail | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	return {
		unlimited: record.unlimited === true,
		// The endpoint sends the same figure as both `remaining` and `quota_remaining`.
		remaining: asNumber(record.remaining) ?? asNumber(record.quota_remaining),
		entitlement: asNumber(record.entitlement),
		percentRemaining: asNumber(record.percent_remaining),
		overageCount: asNumber(record.overage_count),
	};
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
	const { remaining, entitlement } = detail;
	if (remaining === undefined || entitlement === undefined) {
		return `${label}: quota unavailable.`;
	}
	// Prefer the reported percentage; derive it when absent so the line always has one.
	const ratio = detail.percentRemaining ?? (entitlement > 0 ? (remaining / entitlement) * 100 : 0);
	const base = `${label}: ${remaining} of ${entitlement} remaining (${percent(ratio)} percent).`;
	const overage = detail.overageCount ?? 0;
	if (overage > 0) {
		return `${base} Overage used: ${overage}.`;
	}
	return base;
}

/** Reads a credential stored by /login (auth.json in the agent directory). */
export type StoredCredentialReader = (providerId: string) => Credential | undefined;

const readStoredAuthCredential: StoredCredentialReader = (providerId) =>
	readStoredCredential(providerId, getAuthPath());

/** Run `/usage`: fetch and print the Copilot premium-request quota. */
export async function handleUsage(
	ctx: CommandContext,
	readCredential: StoredCredentialReader = readStoredAuthCredential,
): Promise<void> {
	const credential = readCredential(GITHUB_COPILOT_PROVIDER_ID);
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

	const data = asRecord(raw);
	if (!data) {
		ctx.writer.error("Could not read quota: unexpected response.");
		return;
	}

	const plan = asText(data.copilot_plan);
	if (plan) {
		ctx.writer.line(`Copilot plan: ${plan}.`);
	}

	const snapshots = asRecord(data.quota_snapshots) ?? {};
	const lines = [
		quotaLine("Premium requests", readQuota(snapshots.premium_interactions)),
		quotaLine("Chat", readQuota(snapshots.chat)),
		quotaLine("Completions", readQuota(snapshots.completions)),
	].filter((line): line is string => line !== undefined);

	if (lines.length === 0) {
		ctx.writer.line("No quota information was returned for this account.");
	} else {
		for (const line of lines) {
			ctx.writer.line(line);
		}
	}

	const resetDate = asText(data.quota_reset_date);
	if (resetDate) {
		ctx.writer.line(`Quota resets on ${resetDate}.`);
	}
}
