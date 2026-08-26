import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../src/modes/accessible/types.ts";
import { handleUsage } from "../src/modes/accessible/usage.ts";
import { createRecordingWriter } from "./accessible-test-support.ts";

/** Build a minimal CommandContext whose auth storage returns `credential`. */
function makeCtx(credential: unknown) {
	const rec = createRecordingWriter();
	const get = vi.fn().mockReturnValue(credential);
	const ctx = {
		session: { modelRegistry: { authStorage: { get } } },
		writer: rec.writer,
	} as unknown as CommandContext;
	return { ctx, rec, get };
}

/** Stub global fetch with a single JSON response (or an ok:false response). */
function stubFetch(body: unknown, ok = true, status = 200, statusText = "OK") {
	const fetchMock = vi.fn().mockResolvedValue({
		ok,
		status,
		statusText,
		json: async () => body,
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const COPILOT_CREDENTIAL = { type: "oauth", refresh: "gho_token", access: "copilot_token", expires: 0 };

describe("/usage", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("reports when not signed in to GitHub Copilot", async () => {
		const { ctx, rec, get } = makeCtx(undefined);
		await handleUsage(ctx);
		expect(get).toHaveBeenCalledWith("github-copilot");
		expect(rec.lines.join("\n")).toContain("Not signed in to GitHub Copilot");
	});

	it("reports when the stored credential is an API key, not OAuth", async () => {
		const { ctx, rec } = makeCtx({ type: "api_key", key: "abc" });
		await handleUsage(ctx);
		expect(rec.lines.join("\n")).toContain("Not signed in to GitHub Copilot");
	});

	it("prints plan, quota buckets, and reset date from the response", async () => {
		const fetchMock = stubFetch({
			copilot_plan: "individual",
			quota_reset_date: "2026-08-01",
			quota_snapshots: {
				premium_interactions: {
					entitlement: 300,
					remaining: 250,
					percent_remaining: 83.3,
					overage_count: 0,
					unlimited: false,
				},
				chat: { unlimited: true },
				completions: { unlimited: true },
			},
		});
		const { ctx, rec } = makeCtx(COPILOT_CREDENTIAL);
		await handleUsage(ctx);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/copilot_internal/user",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "token gho_token" }),
			}),
		);
		expect(rec.lines).toContain("Copilot plan: individual.");
		expect(rec.lines).toContain("Premium requests: 250 of 300 remaining (83 percent).");
		expect(rec.lines).toContain("Chat: unlimited.");
		expect(rec.lines).toContain("Completions: unlimited.");
		expect(rec.lines).toContain("Quota resets on 2026-08-01.");
	});

	it("notes overage usage when present", async () => {
		stubFetch({
			quota_snapshots: {
				premium_interactions: {
					entitlement: 300,
					remaining: 0,
					percent_remaining: 0,
					overage_count: 12,
					unlimited: false,
				},
			},
		});
		const { ctx, rec } = makeCtx(COPILOT_CREDENTIAL);
		await handleUsage(ctx);
		expect(rec.lines).toContain("Premium requests: 0 of 300 remaining (0 percent). Overage used: 12.");
	});

	it("uses the enterprise API host when an enterprise URL is stored", async () => {
		const fetchMock = stubFetch({ quota_snapshots: {} });
		const { ctx } = makeCtx({ ...COPILOT_CREDENTIAL, enterpriseUrl: "company.ghe.com" });
		await handleUsage(ctx);
		expect(fetchMock).toHaveBeenCalledWith("https://api.company.ghe.com/copilot_internal/user", expect.anything());
	});

	it("reports a bucket as unavailable when its numbers are missing or not numeric", async () => {
		stubFetch({
			quota_snapshots: {
				premium_interactions: { entitlement: 300 },
				chat: { entitlement: "lots", remaining: null, percent_remaining: "high" },
				completions: {},
			},
		});
		const { ctx, rec } = makeCtx(COPILOT_CREDENTIAL);
		await handleUsage(ctx);
		expect(rec.lines).toContain("Premium requests: quota unavailable.");
		expect(rec.lines).toContain("Chat: quota unavailable.");
		expect(rec.lines).toContain("Completions: quota unavailable.");
		expect(rec.lines.join("\n")).not.toMatch(/NaN|undefined/);
	});

	it("derives the percentage when the response omits percent_remaining", async () => {
		stubFetch({ quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 75 } } });
		const { ctx, rec } = makeCtx(COPILOT_CREDENTIAL);
		await handleUsage(ctx);
		expect(rec.lines).toContain("Premium requests: 75 of 300 remaining (25 percent).");
	});

	it("falls back to quota_remaining and skips non-string plan and reset fields", async () => {
		stubFetch({
			copilot_plan: { name: "individual" },
			quota_reset_date: 20260801,
			quota_snapshots: { premium_interactions: { entitlement: 50, quota_remaining: 10, percent_remaining: 20 } },
		});
		const { ctx, rec } = makeCtx(COPILOT_CREDENTIAL);
		await handleUsage(ctx);
		expect(rec.lines).toEqual(["Premium requests: 10 of 50 remaining (20 percent)."]);
	});

	it("treats a non-object quota_snapshots as no quota information", async () => {
		stubFetch({ quota_snapshots: "none" });
		const { ctx, rec } = makeCtx(COPILOT_CREDENTIAL);
		await handleUsage(ctx);
		expect(rec.lines).toContain("No quota information was returned for this account.");
	});

	it("prints an error when the request fails", async () => {
		stubFetch({}, false, 401, "Unauthorized");
		const { ctx, rec } = makeCtx(COPILOT_CREDENTIAL);
		await handleUsage(ctx);
		expect(rec.errors.join("\n")).toContain("Could not read quota: 401 Unauthorized.");
	});
});
