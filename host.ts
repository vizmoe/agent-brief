import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

export type HostUI = Pick<ExtensionUIContext, "select" | "input" | "notify"> & {
	confirm?: ExtensionUIContext["confirm"];
	editor?: ExtensionUIContext["editor"];
};

export type HostModel = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;
export type HostModelRegistry = Pick<ExtensionContext["modelRegistry"], "find" | "complete">;

export type HostContext = Pick<
	ExtensionContext,
	"mode" | "hasUI" | "isIdle" | "hasPendingMessages"
> & {
	ui: HostUI;
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
	model?: HostModel;
	modelRegistry?: HostModelRegistry;
};

export type HostAPI = Pick<ExtensionAPI, "on" | "events" | "registerCommand">;
