// ─── Shared State ────────────────────────────────────────────────────────
// Mutable state shared across all event handlers in the extension.
// This is the "body" of the butler — everything that changes during a session.
// identity and state are undefined until session_start initializes them.
// Use the .id and .st getters for safe access (throws if not initialized).

import type {
	ButlerIdentity,
	SomaticState,
	HeartbeatState,
	PiEvents,
} from "./types.js";

export interface ButlerState {
	/** Identity — set during session_start, undefined before that. */
	identity: ButlerIdentity | undefined;
	/** Somatic state — set during session_start, undefined before that. */
	state: SomaticState | undefined;
	somaticMemory: string;
	heartbeat: HeartbeatState;
	subagentsReady: boolean;
	piEvents: PiEvents | null;
}

export function createButlerState(): ButlerState {
	return {
		identity: undefined,
		state: undefined,
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

/** Get identity, throwing if session hasn't started yet. */
export function id(bs: ButlerState): ButlerIdentity {
	if (!bs.identity) throw new Error("[somatic-butler] identity accessed before session_start");
	return bs.identity;
}

/** Get somatic state, throwing if session hasn't started yet. */
export function st(bs: ButlerState): SomaticState {
	if (!bs.state) throw new Error("[somatic-butler] state accessed before session_start");
	return bs.state;
}
