import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTokenQuota } from "../src/modes/accessible/token-quota.ts";
import type { CommandContext } from "../src/modes/accessible/types.ts";
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

describe("/token quota", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("reports when not signed in to GitHub Copilot", async () => {
		const { ctx, rec, get } = makeCtx(undefined);
		await handleTokenQuota(ctx);
		expect(get).toHaveBeenCalledWith("github-copilot");
		expect(rec.lines.join("\n")).toContain("Not signed in to GitHub Copilot");
	});

	it("reports when the stored credential is an API key, not OAuth", async () => {
		const { ctx, rec } = makeCtx({ type: "api_key", key: "abc" });
		await handleTokenQuota(ctx);
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
		await handleTokenQuota(ctx);

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
		await handleTokenQuota(ctx);
		expect(rec.lines).toContain("Premium requests: 0 of 300 remaining (0 percent). Overage used: 12.");
	});

	it("uses the enterprise API host when an enterprise URL is stored", async () => {
		const fetchMock = stubFetch({ quota_snapshots: {} });
		const { ctx } = makeCtx({ ...COPILOT_CREDENTIAL, enterpriseUrl: "company.ghe.com" });
		await handleTokenQuota(ctx);
		expect(fetchMock).toHaveBeenCalledWith("https://api.company.ghe.com/copilot_internal/user", expect.anything());
	});

	it("prints an error when the request fails", async () => {
		stubFetch({}, false, 401, "Unauthorized");
		const { ctx, rec } = makeCtx(COPILOT_CREDENTIAL);
		await handleTokenQuota(ctx);
		expect(rec.errors.join("\n")).toContain("Could not read quota: 401 Unauthorized.");
	});
});
