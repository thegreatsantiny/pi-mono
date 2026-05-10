// ─── Types ────────────────────────────────────────────────────────────────

export interface ButlerIdentity {
	familyName: string;
	generation: number;
	personalName: string;
	fullName: string;
	birthDate: string;
	creatorId: string;
	corePurpose: string;
}

export interface SomaticState {
	painLevel: number;
	satisfactionLevel: number;
	fatigueLevel: number;
	urgencyLevel: number;
	curiosityLevel: number;
	turnsThisSession: number;
	errorsThisSession: number;
	successesThisSession: number;
	lastCompactionAt: number | null;
	approvedRisks: ApprovedRiskPattern[];
	painPatterns: PainPattern[];
	satisfactionPatterns: SatisfactionPattern[];
	identifiedGaps: IdentifiedGap[];
	_overflowDeathWritten?: boolean;
}

export interface ApprovedRiskPattern {
	pattern: string;
	approvedAt: string;
	suppressWarnings: boolean;
}

export interface PainPattern {
	pattern: string;
	severity: number;
	occurrenceCount: number;
	lastOccurrence: string;
	decayedSeverity: number;
	/** True once this pattern has been promoted to permanent somatic memory. */
	promotedToLesson?: boolean;
}

// ─── Identified Gaps ────────────────────────────────────────────────────

export type GapSeverity = "nice-to-have" | "important" | "critical";

export interface IdentifiedGap {
	/** Unique ID, e.g. "gap:bash:docker-permission" */
	id: string;
	/** Human-readable description of what Alfred cannot do. */
	description: string;
	/** Broad category: infrastructure, integration, domain-knowledge, tooling, other. */
	category: string;
	/** How badly Alfred needs to fill this gap. */
	severity: GapSeverity;
	/** ISO timestamp when first identified. */
	firstIdentified: string;
	/** How many times this gap was hit. */
	occurrenceCount: number;
	/** ISO timestamp of most recent hit. */
	lastOccurrence: string;
	/** What was tried to work around this gap. */
	attemptedWorkarounds: string[];
	/** What kind of specialist/temp worker could fill this gap. */
	suggestedSuccessor: string;
}

export interface SatisfactionPattern {
	pattern: string;
	intensity: number;
	occurrenceCount: number;
	lastOccurrence: string;
}

// ─── Lineage Types ────────────────────────────────────────────────────────

export interface LineageBirthEntry {
	type: "birth";
	id: string;
	parent: string | null;
	generation: number;
	personalName: string;
	familyName: string;
	corePurpose: string;
	inheritedGaps?: string[];
	birthDate: string;
	creatorId: string;
}

export interface LineageDeathEntry {
	type: "death";
	id: string;
	deathDate: string;
	cause: "retired" | "context-overflow" | "crash";
	bequeathal: {
		wisdom: string[];
		gaps: string[];
		approvedRisks: string[];
		failedApproaches: string[];
		unfinishedPurpose: string;
	};
}

export type LineageEntry = LineageBirthEntry | LineageDeathEntry;

// ─── Child Genome ─────────────────────────────────────────────────────────

export interface ChildGenome {
	familyName: string;
	generation: number;
	personalName: string;
	fullName: string;
	corePurpose: string;
	parentId: string;
	inheritedWisdom: string[];
	inheritedGaps: string[];
	inheritedRisks: string[];
	childModel?: string;
	birthDate: string;
	/** Is this a temp worker (not a successor)? Changes system prompt and lineage behavior. */
	isWorker?: boolean;
	/** Tools this agent is allowed to use (territory declaration). Empty = all tools. */
	toolsAllowed?: string[];
	/** Tools this agent is NOT allowed to use (territory restriction). */
	toolsDisallowed?: string[];
	/** Isolation mode — "worktree" runs in a temp git worktree. */
	isolation?: "worktree";
	/** Persistent memory scope — workers can have cross-session memory. */
	memoryScope?: "project" | "local" | "user";
}

// ─── Heartbeat ────────────────────────────────────────────────────────────

export type BreathPhase = "inhaling" | "exhaling" | "steady";

export interface HeartbeatState {
	recentToolNames: string[];
	currentPhase: BreathPhase;
	turnIndex: number;
}

// ─── Pi Events ────────────────────────────────────────────────────────────

export interface PiEvents {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

// ─── Risk Detection ───────────────────────────────────────────────────────

export interface DetectedRisk {
	pattern: string;
	description: string;
}

// ─── Child Genome Detection ───────────────────────────────────────────────

export interface DetectedGenome {
	isChild: true;
	fullName: string;
	generation: number;
	personalName: string;
	familyName: string;
	corePurpose: string;
	parentId: string;
}
