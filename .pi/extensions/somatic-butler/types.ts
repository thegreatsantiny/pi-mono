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
