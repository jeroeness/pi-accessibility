import { describe, expect, it } from "vitest";
import { isUnknownModel, modelLabel } from "../src/modes/accessible/model-label.ts";

const model = (provider: string, id: string) => ({ provider, id }) as any;

describe("isUnknownModel", () => {
	it("is true only for the unknown/unknown placeholder", () => {
		expect(isUnknownModel(model("unknown", "unknown"))).toBe(true);
		expect(isUnknownModel(model("anthropic", "opus"))).toBe(false);
		expect(isUnknownModel(undefined)).toBe(false);
	});
});

describe("modelLabel", () => {
	it("returns provider/id for a real model", () => {
		expect(modelLabel(model("anthropic", "claude-opus-4-5"))).toBe("anthropic/claude-opus-4-5");
	});

	it("returns 'none' for missing or unknown models", () => {
		expect(modelLabel(undefined)).toBe("none");
		expect(modelLabel(model("unknown", "unknown"))).toBe("none");
	});
});
