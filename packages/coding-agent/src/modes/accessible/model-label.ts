/** Model display helpers for accessible mode. */

import type { Model } from "@earendil-works/pi-ai";

/** A restored-but-unresolved model placeholder (no usable auth/definition). */
export function isUnknownModel(model: Model<any> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown";
}

/** Short label for the active model, or "none" when nothing usable is selected. */
export function modelLabel(model: Model<any> | undefined): string {
	return !model || isUnknownModel(model) ? "none" : `${model.provider}/${model.id}`;
}
