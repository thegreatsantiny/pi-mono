// ─── Constants ──────────────────────────────────────────────────────────

import type { BreathPhase } from "./types.js";

export const DEFAULT_FAMILY_NAME = "Pennyworth";
export const GENERATION = 0;
export const DEFAULT_NAME = "Alfred";
export const DEFAULT_CREATOR = "shaun";
export const DEFAULT_PURPOSE = "Be right hand for software development and business operations";

// Decay rates
export const PAIN_DECAY_PER_TURN = 0.85;
export const SATISFACTION_DECAY_PER_TURN = 0.95;
export const FATIGUE_DECAY_BETWEEN_SESSIONS = 30;
export const PAIN_DECAY_BETWEEN_SESSIONS = 0.5;

// In-session tracking
export const STATE_ENTRY_TYPE = "butler-state";

// Somatic memory capacity
export const SOMATIC_MEMORY_CAPACITY = 2000;

// Heartbeat
export const HEARTBEAT_WINDOW = 5;

export const INHALE_TOOLS = new Set(["read", "ls", "find", "grep", "glob"]);
export const EXHALE_TOOLS = new Set(["write", "edit", "bash"]);

// Default somatic memory template
export const DEFAULT_SOMATIC_MEMORY = `# Somatic Memory — Permanent Lessons & Known Risks

## Permanent Lessons (pain that doesn't decay)
- (none yet — these are things you learned the hard way)

## Approved Risks (human confirmed these are acceptable)
- (none approved yet)

## Identified Gaps (what you cannot do)
- (none identified yet)
`;

// Somatic memory section keys — used for reliable section targeting
export const SOMATIC_SECTIONS = {
	permanentLessons: "## Permanent Lessons (pain that doesn't decay)",
	approvedRisks: "## Approved Risks (human confirmed these are acceptable)",
	identifiedGaps: "## Identified Gaps (what you cannot do)",
} as const;

// Human feedback regex patterns
export const POSITIVE_FEEDBACK = /\b(good job|great|perfect|well done|nice|excellent|thanks|thank you|spot on|nailed it|that's right|correct|exactly)\b/i;
export const NEGATIVE_FEEDBACK = /\b(wrong|not what i meant|that's incorrect|nope|bad|terrible|stop|don't do that|not helpful|useless|mistake|error|fix that|try again|redo)\b/i;

// Risk patterns for judgment protocol
export const RISK_PATTERNS: { pattern: string; regex: RegExp; description: string }[] = [
	{ pattern: "bash:rm-rf", regex: /\brm\s+.*-rf\b|\brm\s+-rf\b/, description: "Recursive force delete — irreversible file removal" },
	{ pattern: "bash:force-flag", regex: /\b--force\b|\b-f\b.*\b--force\b/, description: "Force flag — bypasses safety checks" },
	{ pattern: "sql:drop-table", regex: /\bDROP\s+TABLE\b/i, description: "Dropping a database table — irreversible data loss" },
	{ pattern: "bash:chmod-777", regex: /\bchmod\s+777\b/, description: "World-writable permissions — security risk" },
	{ pattern: "bash:redirect-overwrite", regex: />\s*\/dev\/|>\s*\/etc\//, description: "Overwriting system files" },
];
