// ─── Shared State ────────────────────────────────────────────────────────
// Mutable state shared across all event handlers in the extension.
// This is the "body" of the butler — everything that changes during a session.

import type {
	ButlerIdentity,
	SomaticState,
	HeartbeatState,
	PiEvents,
} from "./types.js";

export interface ButlerState {
	identity: ButlerIdentity;
	state: SomaticState;
	somaticMemory: string;
	heartbeat: HeartbeatState;
	subagentsReady: boolean;
	piEvents: PiEvents | null;
}

export function createButlerState(): ButlerState {
	return {
		identity: undefined as unknown as ButlerIdentity,
		state: undefined as unknown as SomaticState,
		somaticMemory: "",
		heartbeat: {
			recentToolNames: [],
			currentPhase: "steady",
			turnIndex: 0,
		},
		subagentsReady: false,
		piEvents: null,
	};
}
