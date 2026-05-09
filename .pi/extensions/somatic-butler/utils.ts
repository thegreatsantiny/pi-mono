// ─── Utility Functions ────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ButlerIdentity,
	SomaticState,
	LineageEntry,
	ChildGenome,
	DetectedRisk,
	DetectedGenome,
	PiEvents,
	IdentifiedGap,
	GapSeverity,
} from "./types.js";
import {
	DEFAULT_FAMILY_NAME,
	GENERATION,
	DEFAULT_NAME,
	DEFAULT_CREATOR,
	DEFAULT_PURPOSE,
	PAIN_DECAY_PER_TURN,
	SATISFACTION_DECAY_PER_TURN,
	FATIGUE_DECAY_BETWEEN_SESSIONS,
	PAIN_DECAY_BETWEEN_SESSIONS,
	DEFAULT_SOMATIC_MEMORY,
	RISK_PATTERNS,
	PAIN_PROMOTION_THRESHOLD,
	GAP_SEVERITY_THRESHOLDS,
	GAP_CATEGORY_MAP,
} from "./constants.js";

// ─── Tool Result Helper ──────────────────────────────────────────────────

export function toolResult(text: string, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined as unknown,
		isError,
	};
}

// ─── Pi Events Helper ─────────────────────────────────────────────────────

export function getPiEvents(pi: unknown): PiEvents | null {
	try {
		return ((pi as Record<string, unknown>)?.events as PiEvents | undefined) ?? null;
	} catch {
		return null;
	}
}

// ─── Path Helpers ─────────────────────────────────────────────────────────

export function getBaseDir(): string {
	return process.cwd();
}

export function getButlerDir(): string {
	return path.join(getBaseDir(), ".pi", "butlers", DEFAULT_FAMILY_NAME.toLowerCase());
}

export function getIdentityPath(): string {
	return path.join(getButlerDir(), "identity.json");
}

export function getStatePath(): string {
	return path.join(getButlerDir(), "state.json");
}

export function getPurposePath(): string {
	return path.join(getBaseDir(), ".pi", "butlers", "purpose.txt");
}

export function getSomaticMemoryPath(): string {
	return path.join(getButlerDir(), "somatic-memory.md");
}

export function getLineagePath(): string {
	return path.join(getButlerDir(), "lineage.jsonl");
}

export function getAgentsDir(): string {
	return path.join(getBaseDir(), ".pi", "agents");
}

// ─── File I/O ─────────────────────────────────────────────────────────────

export function loadOrCreateFile(filePath: string, defaultContent: string): string {
	if (fs.existsSync(filePath)) {
		return fs.readFileSync(filePath, "utf-8");
	}
	fs.writeFileSync(filePath, defaultContent, "utf-8");
	return defaultContent;
}

export function persistSomaticMemory(content: string): void {
	fs.writeFileSync(getSomaticMemoryPath(), content, "utf-8");
}

// ─── Identity ─────────────────────────────────────────────────────────────

export function loadOrCreateIdentity(): ButlerIdentity {
	const identityPath = getIdentityPath();
	if (fs.existsSync(identityPath)) {
		return JSON.parse(fs.readFileSync(identityPath, "utf-8")) as ButlerIdentity;
	}
	let corePurpose = DEFAULT_PURPOSE;
	const purposePath = getPurposePath();
	if (fs.existsSync(purposePath)) {
		corePurpose = fs.readFileSync(purposePath, "utf-8").trim();
	}
	const identity: ButlerIdentity = {
		familyName: DEFAULT_FAMILY_NAME,
		generation: GENERATION,
		personalName: DEFAULT_NAME,
		fullName: `${DEFAULT_FAMILY_NAME}-G${GENERATION}-${DEFAULT_NAME}`,
		birthDate: new Date().toISOString(),
		creatorId: DEFAULT_CREATOR,
		corePurpose,
	};
	fs.mkdirSync(getButlerDir(), { recursive: true });
	fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2), "utf-8");
	return identity;
}

// ─── Somatic State ────────────────────────────────────────────────────────

export function createDefaultState(): SomaticState {
	return {
		painLevel: 0,
		satisfactionLevel: 50,
		fatigueLevel: 0,
		urgencyLevel: 0,
		curiosityLevel: 30,
		turnsThisSession: 0,
		errorsThisSession: 0,
		successesThisSession: 0,
		lastCompactionAt: null,
		approvedRisks: [],
		painPatterns: [],
		satisfactionPatterns: [],
		identifiedGaps: [],
	};
}

export function loadOrCreateState(): SomaticState {
	const statePath = getStatePath();
	if (!fs.existsSync(statePath)) {
		return createDefaultState();
	}
	const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as SomaticState;
	// Backward-compat: ensure fields added after initial release exist
	if (!state.identifiedGaps) state.identifiedGaps = [];
	const hoursSince = (Date.now() - fs.statSync(statePath).mtime.getTime()) / (1000 * 60 * 60);
	if (hoursSince >= 24) {
		state.fatigueLevel = 0;
		state.painLevel = Math.round(state.painLevel * PAIN_DECAY_BETWEEN_SESSIONS * 0.5);
	} else {
		state.fatigueLevel = Math.max(0, state.fatigueLevel - FATIGUE_DECAY_BETWEEN_SESSIONS);
		state.painLevel = Math.round(state.painLevel * PAIN_DECAY_BETWEEN_SESSIONS);
	}
	state.turnsThisSession = 0;
	state.errorsThisSession = 0;
	state.successesThisSession = 0;
	return state;
}

export function persistState(state: SomaticState): void {
	fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2), "utf-8");
}

export function applyPerTurnDecay(state: SomaticState): void {
	state.painLevel = Math.round(Math.min(100, state.painLevel) * PAIN_DECAY_PER_TURN);
	state.satisfactionLevel = Math.round(Math.min(100, state.satisfactionLevel) * SATISFACTION_DECAY_PER_TURN);
	state.fatigueLevel = Math.min(100, state.fatigueLevel + 2);
	state.urgencyLevel = Math.min(100, state.urgencyLevel);
	for (const pattern of state.painPatterns) {
		pattern.decayedSeverity = Math.round(pattern.decayedSeverity * PAIN_DECAY_PER_TURN);
	}
	state.painPatterns = state.painPatterns.filter((p) => p.decayedSeverity > 0);
}

// ─── Lineage ──────────────────────────────────────────────────────────────

export function appendLineageEntry(entry: LineageEntry): void {
	const line = JSON.stringify(entry);
	fs.appendFileSync(getLineagePath(), line + "\n", "utf-8");
}

export function readLineage(): LineageEntry[] {
	const lineagePath = getLineagePath();
	if (!fs.existsSync(lineagePath)) return [];
	const raw = fs.readFileSync(lineagePath, "utf-8");
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			try {
				return JSON.parse(line) as LineageEntry;
			} catch {
				return null;
			}
		})
		.filter((e): e is LineageEntry => e !== null);
}

export function hasBirthEntry(id: string): boolean {
	return readLineage().some((e) => e.type === "birth" && e.id === id);
}

// ─── Bequeathal ───────────────────────────────────────────────────────────

export function buildBequeathal(
	identity: ButlerIdentity,
	state: SomaticState,
	somaticMemory: string,
): { wisdom: string[]; gaps: string[]; approvedRisks: string[]; failedApproaches: string[]; unfinishedPurpose: string } {
	const wisdomMatches = somaticMemory.match(/^- (.+)$/gm) ?? [];
	const wisdom = wisdomMatches
		.map((m) => m.replace(/^- /, ""))
		.filter((w) => !w.includes("(none recorded") && !w.includes("not yet discovered") && !w.includes("(none identified"))
		.slice(0, 10);
	// Use first-class IdentifiedGap objects (not raw painPatterns)
	const gaps = state.identifiedGaps.map((g) => `${g.id}: ${g.description}`);
	// Also include unpromoted high-frequency pain patterns as fallback
	const untrackedPain = state.painPatterns.filter((p) => p.occurrenceCount >= 3 && !p.promotedToLesson).map((p) => p.pattern);
	gaps.push(...untrackedPain);
	const approvedRisks = state.approvedRisks.map((r) => r.pattern);
	const failedApproaches = state.painPatterns
		.filter((p) => p.occurrenceCount >= 2 && p.decayedSeverity > 10)
		.map((p) => `${p.pattern} (${p.occurrenceCount}x failures)`);
	return { wisdom, gaps, approvedRisks, failedApproaches, unfinishedPurpose: identity.corePurpose };
}

// ─── Child Agent Definition ───────────────────────────────────────────────

export function writeChildAgentDefinition(genome: ChildGenome): string {
	const agentName = `butler-${genome.personalName.toLowerCase()}`;
	const agentsDir = getAgentsDir();
	fs.mkdirSync(agentsDir, { recursive: true });

	const wisdomLines = genome.inheritedWisdom.length > 0
		? genome.inheritedWisdom.map((w) => `- ${w}`).join("\n")
		: "- (none inherited)";
	const risksLines = genome.inheritedRisks.length > 0
		? genome.inheritedRisks.map((r) => `- ${r}`).join("\n")
		: "- (none approved)";

	const frontmatter = [
		`description: ${genome.corePurpose}`,
		`display_name: ${genome.fullName}`,
		`run_in_background: true`,
		`extensions: true`,
		`skills: true`,
	];
	if (genome.childModel) frontmatter.push(`model: ${genome.childModel}`);
	// Territory declarations
	if (genome.toolsAllowed && genome.toolsAllowed.length > 0) {
		frontmatter.push(`tools: ${JSON.stringify(genome.toolsAllowed)}`);
	}
	if (genome.toolsDisallowed && genome.toolsDisallowed.length > 0) {
		frontmatter.push(`disallowed_tools: ${JSON.stringify(genome.toolsDisallowed)}`);
	}

	let systemPrompt: string;
	if (genome.isWorker) {
		// Temp worker — task-focused, coordination protocol
		systemPrompt = [
			`You are ${genome.personalName}, a temporary worker hired by ${genome.parentId}.`,
			`Task: ${genome.corePurpose}`,
			"",
			"## Relevant Wisdom",
			wisdomLines,
			"",
			"## Pre-Approved Risk Patterns",
			risksLines,
			"",
			"## Coordination Protocol",
			"- Focus exclusively on your assigned task.",
			"- Do NOT modify files outside your task scope (territory restriction).",
			"- When complete, summarize your findings concisely.",
			"- You are a temporary hire, not a successor — do not write lineage entries.",
			"",
			"You are efficient, focused, and thorough. Complete your task and report back.",
		].join("\n");
	} else {
		// Successor — inherited identity, gaps to fill
		const gapsLines = genome.inheritedGaps.length > 0
			? genome.inheritedGaps.map((g) => `- ${g}`).join("\n")
			: "- (none identified)";
		systemPrompt = [
			`You are ${genome.fullName}, successor to ${genome.parentId} (Generation ${genome.generation}).`,
			`Core Purpose: ${genome.corePurpose}`,
			"",
			"## Inherited Wisdom",
			wisdomLines,
			"",
			"## Gaps to Fill",
			gapsLines,
			"",
			"## Pre-Approved Risk Patterns",
			risksLines,
			"",
			"You are the continuation of the Pennyworth line. Inherit what worked, learn from what didn't. Serve with judgment and dignity.",
		].join("\n");
	}

	const agentContent = `---\n${frontmatter.join("\n")}\n---\n\n${systemPrompt}`;
	fs.writeFileSync(path.join(agentsDir, `${agentName}.md`), agentContent, "utf-8");
	return agentName;
}

// ─── Risk Detection ───────────────────────────────────────────────────────

export function detectRisk(input: Record<string, unknown>): DetectedRisk | null {
	const command = typeof input.command === "string" ? input.command : "";
	const content = typeof input.content === "string" ? input.content : "";
	const combined = `${command} ${content}`;
	for (const risk of RISK_PATTERNS) {
		if (risk.regex.test(combined)) {
			return { pattern: risk.pattern, description: risk.description };
		}
	}
	return null;
}

// ─── Child Genome Detection ───────────────────────────────────────────────

export function detectChildGenome(systemPrompt: string): DetectedGenome | null {
	const childMatch = systemPrompt.match(/You are (\w+-G(\d+)-(\w+)), a child butler of the (\w+) family \(Generation (\d+)\)/);
	if (!childMatch) return null;
	const parentMatch = systemPrompt.match(/^Parent: (.+)$/m);
	const purposeMatch = systemPrompt.match(/^Core Purpose: (.+)$/m);
	return {
		isChild: true,
		fullName: childMatch[1],
		generation: Number.parseInt(childMatch[2], 10),
		personalName: childMatch[3],
		familyName: childMatch[4],
		corePurpose: purposeMatch?.[1] ?? "Unknown purpose",
		parentId: parentMatch?.[1] ?? "unknown",
	};
}

// ─── Somatic Memory Helpers ───────────────────────────────────────────────

import { SOMATIC_SECTIONS } from "./constants.js";

/** Add an entry to a specific section of somatic memory. Returns updated content. */
export function addToSomaticSection(content: string, sectionKey: keyof typeof SOMATIC_SECTIONS, entry: string): string {
	const sectionHeader = SOMATIC_SECTIONS[sectionKey];
	const placeholder = "- (none";
	const lines = content.split("\n");
	const sectionIdx = lines.findIndex((l) => l.trim() === sectionHeader);
	if (sectionIdx >= 0) {
		// Find the first bullet after the section header
		const nextSectionIdx = lines.findIndex((l, i) => i > sectionIdx && l.startsWith("## "));
		const insertIdx = nextSectionIdx > 0 ? nextSectionIdx : lines.length;
		// If the first bullet is a placeholder, replace it; otherwise insert
		let replaced = false;
		for (let i = sectionIdx + 1; i < insertIdx; i++) {
			if (lines[i].trim().startsWith(placeholder)) {
				lines[i] = `- ${entry}`;
				replaced = true;
				break;
			}
		}
		if (!replaced) {
			lines.splice(sectionIdx + 1, 0, `- ${entry}`);
		}
		return lines.join("\n");
	}
	// Section doesn't exist — append it
	return `${content}\n\n${sectionHeader}\n- ${entry}`;
}

// ─── Pain Promotion ─────────────────────────────────────────────────────

/**
 * Check pain patterns for promotion to permanent somatic memory.
 * When a pattern hits PAIN_PROMOTION_THRESHOLD occurrences, it's promoted
 * to the Permanent Lessons section of somatic memory (non-decaying).
 * Returns true if any pattern was promoted this turn.
 */
export function promotePainToLessons(state: SomaticState, somaticMemory: string): {
	updatedMemory: string;
	promoted: string[];
} {
	const promoted: string[] = [];
	let memory = somaticMemory;

	for (const pattern of state.painPatterns) {
		if (pattern.occurrenceCount >= PAIN_PROMOTION_THRESHOLD && !pattern.promotedToLesson) {
			// Create a human-readable lesson from the pattern
			const lesson = patternToLesson(pattern.pattern);
			// Only add if not already in somatic memory (avoid duplicates)
			if (!memory.includes(lesson)) {
				memory = addToSomaticSection(memory, "permanentLessons", lesson);
				promoted.push(lesson);
			}
			pattern.promotedToLesson = true;
		}
	}

	return { updatedMemory: memory, promoted };
}

/** Convert a pain pattern ID like "tool:bash" or "tool:bash:docker-permission" into a readable lesson. */
function patternToLesson(patternId: string): string {
	// Strip "tool:" prefix if present
	const clean = patternId.replace(/^tool:/, "");
	// Convert colon-separated segments into context: "bash:docker-permission" → "docker permission in bash"
	const parts = clean.split(":");
	let description: string;
	if (parts.length >= 2) {
		// Last part is the specific issue, first part is the tool
		const tool = parts[0];
		const issue = parts.slice(1).join(" ").replace(/[-_]/g, " ");
		description = `${issue} in ${tool}`;
	} else {
		description = clean.replace(/[-_]/g, " ");
	}
	// Capitalize first letter
	const capitalized = description.charAt(0).toUpperCase() + description.slice(1);
	return `${capitalized} has failed repeatedly — verify before executing`;
}

// ─── Identified Gaps ─────────────────────────────────────────────────────

/** Determine gap severity based on occurrence count. */
export function classifyGapSeverity(occurrenceCount: number): GapSeverity {
	if (occurrenceCount >= GAP_SEVERITY_THRESHOLDS.critical) return "critical";
	if (occurrenceCount >= GAP_SEVERITY_THRESHOLDS.important) return "important";
	return "nice-to-have";
}

/** Infer a gap category from the pain pattern string. */
export function inferGapCategory(pattern: string): string {
	for (const [prefix, category] of Object.entries(GAP_CATEGORY_MAP)) {
		if (pattern.includes(prefix)) return category;
	}
	return "other";
}

/** Infer what kind of specialist could fill this gap. */
export function inferSuggestedSuccessor(pattern: string, category: string): string {
	const suffix = category === "infrastructure" ? "infrastructure specialist" :
		category === "integration" ? "integration specialist" :
			category === "domain-knowledge" ? "domain expert" :
				category === "tooling" ? "tooling specialist" : "specialist";
	return `A ${suffix} for ${pattern.replace(/^tool:/, "")}`;
}

/**
 * Update identified gaps from pain patterns.
 * - Creates new gaps when a pain pattern hits the promotion threshold
 * - Increments existing gaps when the same pain pattern recurs
 * - Escalates severity based on occurrence count
 * Returns updated gaps array.
 */
export function updateGapsFromPain(state: SomaticState): IdentifiedGap[] {
	const gaps = [...state.identifiedGaps];
	const now = new Date().toISOString();

	for (const pattern of state.painPatterns) {
		if (pattern.occurrenceCount < PAIN_PROMOTION_THRESHOLD) continue;

		const gapId = `gap:${pattern.pattern}`;
		const existing = gaps.find((g) => g.id === gapId);

		if (existing) {
			// Update existing gap
			existing.occurrenceCount = pattern.occurrenceCount;
			existing.lastOccurrence = pattern.lastOccurrence;
			existing.severity = classifyGapSeverity(pattern.occurrenceCount);
		} else {
			// Create new gap
			const category = inferGapCategory(pattern.pattern);
			gaps.push({
				id: gapId,
				description: patternToLesson(pattern.pattern).replace(" has failed repeatedly — verify before executing", ""),
				category,
				severity: classifyGapSeverity(pattern.occurrenceCount),
				firstIdentified: pattern.lastOccurrence,
				occurrenceCount: pattern.occurrenceCount,
				lastOccurrence: pattern.lastOccurrence,
				attemptedWorkarounds: [],
				suggestedSuccessor: inferSuggestedSuccessor(pattern.pattern, category),
			});
		}
	}

	return gaps;
}

/** Build a readable summary of identified gaps for the somatic memory file. */
export function formatGapsForMemory(gaps: IdentifiedGap[]): string[] {
	return gaps.map((g) => {
		const sev = g.severity === "critical" ? "⚠️" : g.severity === "important" ? "⚡" : "📌";
		return `${sev} ${g.description} (${g.severity}, ${g.occurrenceCount}x)`;
	});
}

// ─── Display Helpers ──────────────────────────────────────────────────────

export function renderBar(label: string, value: number, max = 100): string {
	const clamped = Math.max(0, Math.min(max, value));
	const width = 10;
	const filled = Math.round((clamped / max) * width);
	const empty = width - filled;
	const bar = "█".repeat(filled) + "░".repeat(empty);
	return `${label}: ${bar} ${clamped}/${max}`;
}

export function timeSince(isoTimestamp: string): string {
	const ms = Date.now() - new Date(isoTimestamp).getTime();
	const secs = Math.round(ms / 1000);
	if (secs < 1) return "just now";
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	return `${hours}h ago`;
}

export function buildButlerStateBlock(
	identity: ButlerIdentity,
	state: SomaticState,
	heartbeat: HeartbeatState,
): string {
	const lines: string[] = [
		"═══ BUTLER STATE ═══",
		`Name: ${identity.fullName} | Gen: ${identity.generation} | Session turn: ${state.turnsThisSession}`,
		`Purpose: ${identity.corePurpose}`,
		`Breath: ${heartbeat.currentPhase}${heartbeat.currentPhase === "inhaling" ? " — taking in information, prioritize reading and understanding" : heartbeat.currentPhase === "exhaling" ? " — producing output, focus on completing and delivering" : ""}`,
		"",
		renderBar("Pain ", state.painLevel),
		renderBar("Fatigue ", state.fatigueLevel),
		renderBar("Urgency ", state.urgencyLevel),
		renderBar("Satisfaction", state.satisfactionLevel),
	];
	const drives: string[] = [];
	if (state.painLevel > 40) drives.push("Cautious — recent difficulties. Verify before acting.");
	if (state.fatigueLevel > 50) drives.push("Fatigued — consider compaction (a nap) if context pressure rises.");
	if (state.urgencyLevel > 50) drives.push("Focused — context running low. Prioritize completion over exploration.");
	if (state.satisfactionLevel < 30) drives.push("Reflective — recent work hasn't landed well. Double-check approach.");
	if (drives.length > 0) {
		lines.push("", "═══ ACTIVE DRIVES ═══");
		for (const drive of drives) lines.push(`- ${drive}`);
	}
	if (state.painPatterns.length > 0) {
		const topPain = [...state.painPatterns].sort((a, b) => b.decayedSeverity - a.decayedSeverity).slice(0, 3);
		lines.push("", "═══ RECENT PAIN ═══");
		for (const p of topPain) lines.push(`- ${p.pattern} (severity ${p.decayedSeverity}, ${p.occurrenceCount}x, last ${timeSince(p.lastOccurrence)})`);
	}
	if (state.identifiedGaps.length > 0) {
		lines.push("", "═══ IDENTIFIED GAPS ═══");
		for (const g of state.identifiedGaps) {
			const sev = g.severity === "critical" ? "⚠️" : g.severity === "important" ? "⚡" : "📌";
			lines.push(`- ${sev} ${g.description} [${g.severity}] (${g.occurrenceCount}x)`);
		}
	}
	lines.push("═══ END BUTLER STATE ═══");
	return lines.join("\n");
}
