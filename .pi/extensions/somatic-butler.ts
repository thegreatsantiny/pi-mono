import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────

interface ButlerIdentity {
	familyName: string;
	generation: number;
	personalName: string;
	fullName: string;
	birthDate: string;
	creatorId: string;
	corePurpose: string;
}

interface SomaticState {
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
}

interface ApprovedRiskPattern {
	pattern: string;
	approvedAt: string;
	suppressWarnings: boolean;
}

interface PainPattern {
	pattern: string;
	severity: number;
	occurrenceCount: number;
	lastOccurrence: string;
	decayedSeverity: number;
}

interface SatisfactionPattern {
	pattern: string;
	intensity: number;
	occurrenceCount: number;
	lastOccurrence: string;
}

// ─── Lineage Types ────────────────────────────────────────────────────────

interface LineageBirthEntry {
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

interface LineageDeathEntry {
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

type LineageEntry = LineageBirthEntry | LineageDeathEntry;

// ─── Constants ──────────────────────────────────────────────────────────

const DEFAULT_FAMILY_NAME = "Pennyworth";
const GENERATION = 0;
const DEFAULT_NAME = "Alfred";
const DEFAULT_CREATOR = "shaun";
const DEFAULT_PURPOSE = "Be right hand for software development and business operations";

// Decay rates
const PAIN_DECAY_PER_TURN = 0.85;
const SATISFACTION_DECAY_PER_TURN = 0.95;
const FATIGUE_DECAY_BETWEEN_SESSIONS = 30;
const PAIN_DECAY_BETWEEN_SESSIONS = 0.5;

// In-session tracking
const STATE_ENTRY_TYPE = "butler-state";

// Memory capacity
const MEMORY_CAPACITY = 2000;
const USER_PROFILE_CAPACITY = 1000;

// Heartbeat
const HEARTBEAT_WINDOW = 5;

type BreathPhase = "inhaling" | "exhaling" | "steady";

interface HeartbeatState {
	recentToolNames: string[];
	currentPhase: BreathPhase;
	turnIndex: number;
}

const INHALE_TOOLS = new Set(["read", "ls", "find", "grep", "glob"]);
const EXHALE_TOOLS = new Set(["write", "edit", "bash"]);

// ─── Tool Result Helper ──────────────────────────────────────────────────

function toolResult(text: string, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined as unknown,
		isError,
	};
}

// ─── Path Helpers ─────────────────────────────────────────────────────────

function getBaseDir(): string {
	return process.cwd();
}

function getButlerDir(): string {
	return path.join(getBaseDir(), ".pi", "butlers", DEFAULT_FAMILY_NAME.toLowerCase());
}

function getIdentityPath(): string {
	return path.join(getButlerDir(), "identity.json");
}

function getStatePath(): string {
	return path.join(getButlerDir(), "state.json");
}

function getPurposePath(): string {
	return path.join(getBaseDir(), ".pi", "butlers", "purpose.txt");
}

function getMemoryPath(): string {
	return path.join(getButlerDir(), "memory.md");
}

function getUserProfilePath(): string {
	return path.join(getButlerDir(), "user-profile.md");
}

function getLineagePath(): string {
	return path.join(getButlerDir(), "lineage.jsonl");
}

// ─── Identity ─────────────────────────────────────────────────────────────

function loadOrCreateIdentity(): ButlerIdentity {
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

function persistIdentity(identity: ButlerIdentity): void {
	fs.writeFileSync(getIdentityPath(), JSON.stringify(identity, null, 2), "utf-8");
}

// ─── Memory ───────────────────────────────────────────────────────────────

const DEFAULT_MEMORY = `# Pennyworth-G0-Alfred — Memory

## Environment
- Machine: (not yet discovered)
- Key dirs: (not yet discovered)
- Active providers: (not yet discovered)

## Conventions
- (none recorded yet)

## Lessons Learned
- (none recorded yet)

## Active Gaps
- (none identified yet)
`;

const DEFAULT_USER_PROFILE = `# User Profile — Shaun

## Preferences
- (not yet discovered)

## Communication Style
- (not yet discovered)

## Working Patterns
- (not yet discovered)
`;

function loadOrCreateFile(filePath: string, defaultContent: string): string {
	if (fs.existsSync(filePath)) {
		return fs.readFileSync(filePath, "utf-8");
	}
	fs.writeFileSync(filePath, defaultContent, "utf-8");
	return defaultContent;
}

function persistMemory(content: string): void {
	fs.writeFileSync(getMemoryPath(), content, "utf-8");
}

function persistUserProfile(content: string): void {
	fs.writeFileSync(getUserProfilePath(), content, "utf-8");
}

// ─── Lineage ─────────────────────────────────────────────────────────────

function appendLineageEntry(entry: LineageEntry): void {
	const line = JSON.stringify(entry);
	fs.appendFileSync(getLineagePath(), line + "\n", "utf-8");
}

function readLineage(): LineageEntry[] {
	const lineagePath = getLineagePath();
	if (!fs.existsSync(lineagePath)) return [];
	const raw = fs.readFileSync(lineagePath, "utf-8");
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			try { return JSON.parse(line) as LineageEntry; }
			catch { return null; }
		})
		.filter((e): e is LineageEntry => e !== null);
}

function hasBirthEntry(id: string): boolean {
	return readLineage().some((e) => e.type === "birth" && e.id === id);
}

function buildBequeathal(identity: ButlerIdentity, state: SomaticState, memory: string): LineageDeathEntry["bequeathal"] {
	// Extract wisdom from memory — top lessons learned
	const wisdomMatches = memory.match(/^- (.+)$/gm) ?? [];
	const wisdom = wisdomMatches
		.map((m) => m.replace(/^- /, ""))
		.filter((w) => !w.includes("(none recorded") && !w.includes("not yet discovered"))
		.slice(0, 10);

	// Gaps from pain patterns with 3+ occurrences
	const gaps = state.painPatterns
		.filter((p) => p.occurrenceCount >= 3)
		.map((p) => p.pattern);

	// Approved risk patterns
	const approvedRisks = state.approvedRisks.map((r) => r.pattern);

	// Failed approaches from pain patterns
	const failedApproaches = state.painPatterns
		.filter((p) => p.occurrenceCount >= 2 && p.decayedSeverity > 10)
		.map((p) => `${p.pattern} (${p.occurrenceCount}x failures)`);

	// Unfinished purpose
	const unfinishedPurpose = identity.corePurpose;

	return { wisdom, gaps, approvedRisks, failedApproaches, unfinishedPurpose };
}

// ─── Risk Patterns ────────────────────────────────────────────────────────

const RISK_PATTERNS: { pattern: string; regex: RegExp; description: string }[] = [
	{ pattern: "bash:rm-rf", regex: /\brm\s+.*-rf\b|\brm\s+-rf\b/, description: "Recursive force delete — irreversible file removal" },
	{ pattern: "bash:force-flag", regex: /\b--force\b|\b-f\b.*\b--force\b/, description: "Force flag — bypasses safety checks" },
	{ pattern: "sql:drop-table", regex: /\bDROP\s+TABLE\b/i, description: "Dropping a database table — irreversible data loss" },
	{ pattern: "bash:chmod-777", regex: /\bchmod\s+777\b/, description: "World-writable permissions — security risk" },
	{ pattern: "bash:redirect-overwrite", regex: />\s*\/dev\/|>\s*\/etc\//, description: "Overwriting system files" },
];

function detectRisk(input: Record<string, unknown>): { pattern: string; description: string } | null {
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

// ─── Somatic State ────────────────────────────────────────────────────────

function createDefaultState(): SomaticState {
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
	};
}

function loadOrCreateState(): SomaticState {
	const statePath = getStatePath();
	if (!fs.existsSync(statePath)) {
		return createDefaultState();
	}

	const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as SomaticState;

	// Apply between-session decay
	const hoursSince = (Date.now() - fs.statSync(statePath).mtime.getTime()) / (1000 * 60 * 60);
	if (hoursSince >= 24) {
		state.fatigueLevel = 0;
		state.painLevel = Math.round(state.painLevel * PAIN_DECAY_BETWEEN_SESSIONS * 0.5);
	} else {
		state.fatigueLevel = Math.max(0, state.fatigueLevel - FATIGUE_DECAY_BETWEEN_SESSIONS);
		state.painLevel = Math.round(state.painLevel * PAIN_DECAY_BETWEEN_SESSIONS);
	}

	// Reset per-session counters
	state.turnsThisSession = 0;
	state.errorsThisSession = 0;
	state.successesThisSession = 0;
	return state;
}

function persistState(state: SomaticState): void {
	fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2), "utf-8");
}

function applyPerTurnDecay(state: SomaticState): void {
	state.painLevel = Math.round(state.painLevel * PAIN_DECAY_PER_TURN);
	state.satisfactionLevel = Math.round(state.satisfactionLevel * SATISFACTION_DECAY_PER_TURN);
	state.fatigueLevel = Math.min(100, state.fatigueLevel + 2);

	// Decay individual pain patterns
	for (const pattern of state.painPatterns) {
		pattern.decayedSeverity = Math.round(pattern.decayedSeverity * PAIN_DECAY_PER_TURN);
	}
	state.painPatterns = state.painPatterns.filter((p) => p.decayedSeverity > 0);
}

// ─── System Prompt Injection ───────────────────────────────────────────

function renderBar(label: string, value: number, max = 100): string {
	const width = 10;
	const filled = Math.round((value / max) * width);
	const empty = width - filled;
	const bar = "█".repeat(filled) + "░".repeat(empty);
	return `${label}: ${bar} ${value}/${max}`;
}

function buildButlerStateBlock(identity: ButlerIdentity, state: SomaticState, heartbeat: HeartbeatState): string {
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
		for (const drive of drives) {
			lines.push(`- ${drive}`);
		}
	}

	if (state.painPatterns.length > 0) {
		const topPain = [...state.painPatterns]
			.sort((a, b) => b.decayedSeverity - a.decayedSeverity)
			.slice(0, 3);
		lines.push("", "═══ RECENT PAIN ═══");
		for (const p of topPain) {
			lines.push(`- ${p.pattern} (severity ${p.decayedSeverity}, ${p.occurrenceCount}x, last ${timeSince(p.lastOccurrence)})`);
		}
	}

	lines.push("═══ END BUTLER STATE ═══");
	return lines.join("\n");
}

function timeSince(isoTimestamp: string): string {
	const ms = Date.now() - new Date(isoTimestamp).getTime();
	const secs = Math.round(ms / 1000);
	if (secs < 1) return "just now";
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	return `${hours}h ago`;
}

// ─── Human Feedback Patterns ─────────────────────────────────────────────

const POSITIVE_FEEDBACK = /\b(good job|great|perfect|well done|nice|excellent|thanks|thank you|spot on|nailed it|that's right|correct|exactly)\b/i;
const NEGATIVE_FEEDBACK = /\b(wrong|not what i meant|that's incorrect|nope|bad|terrible|stop|don't do that|not helpful|useless|mistake|error|fix that|try again|redo)\b/i;

// ─── Extension ───────────────────────────────────────────────────────────

export default function somaticButlerExtension(pi: ExtensionAPI) {
	let identity: ButlerIdentity;
	let state: SomaticState;
	let memory: string;
	let userProfile: string;
	let heartbeat: HeartbeatState = {
		recentToolNames: [],
		currentPhase: "steady",
		turnIndex: 0,
	};

	// ─── Session Lifecycle ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		identity = loadOrCreateIdentity();
		state = loadOrCreateState();
		memory = loadOrCreateFile(getMemoryPath(), DEFAULT_MEMORY);
		userProfile = loadOrCreateFile(getUserProfilePath(), DEFAULT_USER_PROFILE);

		// Replay in-session state entries for branch-correct state
		try {
			const entries = ctx.sessionManager.getEntries();
			const stateEntries = entries
				.filter((e: unknown) => (e as { type?: string }).type === STATE_ENTRY_TYPE)
				.map((e: unknown) => (e as { data?: unknown }).data as SomaticState | undefined)
				.filter(Boolean);

			if (stateEntries.length > 0) {
				const latest = stateEntries[stateEntries.length - 1] as SomaticState;
				state.painLevel = latest.painLevel ?? state.painLevel;
				state.satisfactionLevel = latest.satisfactionLevel ?? state.satisfactionLevel;
				state.fatigueLevel = latest.fatigueLevel ?? state.fatigueLevel;
				state.urgencyLevel = latest.urgencyLevel ?? state.urgencyLevel;
				state.curiosityLevel = latest.curiosityLevel ?? state.curiosityLevel;
				state.approvedRisks = latest.approvedRisks ?? state.approvedRisks;
				state.painPatterns = latest.painPatterns ?? state.painPatterns;
				state.satisfactionPatterns = latest.satisfactionPatterns ?? state.satisfactionPatterns;
			}
		} catch {
			// getEntries may not be available — use filesystem state only
		}

		ctx.ui.notify(`${identity.fullName} is waking up.`, "info");

		// Record birth in lineage if not already present
		if (!hasBirthEntry(identity.fullName)) {
			const birthEntry: LineageBirthEntry = {
				type: "birth",
				id: identity.fullName,
				parent: null, // G0 has no parent; children will set this
				generation: identity.generation,
				personalName: identity.personalName,
				familyName: identity.familyName,
				corePurpose: identity.corePurpose,
				birthDate: identity.birthDate,
				creatorId: identity.creatorId,
			};
			appendLineageEntry(birthEntry);
		}

		// Register TUI status widget
		if (ctx.hasUI) {
			ctx.ui.setWidget(
				"butler-status",
				[`${identity.fullName} [${heartbeat.currentPhase}] | P:${state.painLevel} F:${state.fatigueLevel} U:${state.urgencyLevel} S:${state.satisfactionLevel}`],
			);
		}
	});

	pi.on("session_shutdown", async () => {
		persistIdentity(identity);
		persistState(state);
		persistMemory(memory);
		persistUserProfile(userProfile);

		// Record death in lineage with bequeathal
		const deathEntry: LineageDeathEntry = {
			type: "death",
			id: identity.fullName,
			deathDate: new Date().toISOString(),
			cause: "retired",
			bequeathal: buildBequeathal(identity, state, memory),
		};
		appendLineageEntry(deathEntry);

		console.log(`[somatic-butler] ${identity.fullName} is going to sleep.`);
	});

	// ─── Turn Lifecycle ─────────────────────────────────────────────────

	pi.on("turn_start", async (_event, ctx) => {
		state.turnsThisSession++;
		try {
			const usage = ctx.getContextUsage();
			if (usage && typeof usage.percent === "number") {
				state.urgencyLevel = Math.round(usage.percent * 100);
			}
		} catch {
			// getContextUsage may return null after compaction
		}
	});

	pi.on("tool_result", async (event) => {
		const toolName = (event as { toolName?: string }).toolName ?? "unknown";

		// Update heartbeat
		heartbeat.recentToolNames.push(toolName);
		if (heartbeat.recentToolNames.length > HEARTBEAT_WINDOW) {
			heartbeat.recentToolNames.shift();
		}

		const inhaleCount = heartbeat.recentToolNames.filter((t) => INHALE_TOOLS.has(t)).length;
		const exhaleCount = heartbeat.recentToolNames.filter((t) => EXHALE_TOOLS.has(t)).length;
		if (inhaleCount > exhaleCount + 1) {
			heartbeat.currentPhase = "inhaling";
		} else if (exhaleCount > inhaleCount + 1) {
			heartbeat.currentPhase = "exhaling";
		} else {
			heartbeat.currentPhase = "steady";
		}

		try {
			(pi as unknown as { events: { emit: (ch: string, d: unknown) => void } }).events.emit(
				"butler:heartbeat",
				{ phase: heartbeat.currentPhase, turn: heartbeat.turnIndex },
			);
		} catch {
			// events.emit may not be available
		}

		// Track pain/satisfaction from tool results
		if (event.isError) {
			state.painLevel = Math.min(100, state.painLevel + 20);
			state.errorsThisSession++;
			const patternId = `tool:${toolName}`;
			const existing = state.painPatterns.find((p) => p.pattern === patternId);
			if (existing) {
				existing.severity = Math.min(100, existing.severity + 20);
				existing.decayedSeverity = existing.severity;
				existing.occurrenceCount++;
				existing.lastOccurrence = new Date().toISOString();
			} else {
				state.painPatterns.push({
					pattern: patternId, severity: 20, occurrenceCount: 1,
					lastOccurrence: new Date().toISOString(), decayedSeverity: 20,
				});
			}
		} else {
			state.satisfactionLevel = Math.min(100, state.satisfactionLevel + 10);
			state.successesThisSession++;
			const patternId = `tool:${toolName}`;
			const existing = state.satisfactionPatterns.find((p) => p.pattern === patternId);
			if (existing) {
				existing.intensity = Math.min(100, existing.intensity + 10);
				existing.occurrenceCount++;
				existing.lastOccurrence = new Date().toISOString();
			} else {
				state.satisfactionPatterns.push({
					pattern: patternId, intensity: 10, occurrenceCount: 1,
					lastOccurrence: new Date().toISOString(),
				});
			}
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		applyPerTurnDecay(state);

		// Persist to in-session appendEntry
		try {
			(pi as unknown as { appendEntry: (type: string, data: unknown) => void }).appendEntry(
				STATE_ENTRY_TYPE, { ...state },
			);
		} catch {
			// appendEntry may not be available
		}

		// Update TUI widget
		if (ctx?.hasUI) {
			ctx.ui.setWidget(
				"butler-status",
				[`${identity.fullName} [${heartbeat.currentPhase}] | P:${state.painLevel} F:${state.fatigueLevel} U:${state.urgencyLevel} S:${state.satisfactionLevel}`],
			);
		}
	});

	// ─── Judgment Protocol ──────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		const input = (event as { input?: Record<string, unknown> }).input ?? {};
		const risk = detectRisk(input);
		if (!risk) return;

		const approved = state.approvedRisks.find((r) => r.pattern === risk.pattern);
		if (approved?.suppressWarnings) return;

		if (!ctx.hasUI) {
			return { block: true, reason: `I cannot proceed: ${risk.description}. This requires human confirmation.` };
		}

		const confirmed = await ctx.ui.confirm(
			`Alfred's Judgment`,
			`${risk.description}.\n\nI can proceed, but I want you to be aware of the consequences.\n\nType 'Yes' to proceed, or 'Ignore consequences' to suppress future warnings.`,
			{ yes: "Yes, proceed", no: "Cancel", alternate: "Ignore consequences" },
		);

		if (confirmed === true) {
			state.satisfactionLevel = Math.min(100, state.satisfactionLevel + 5);
			return;
		}

		if (confirmed === "alternate") {
			state.approvedRisks.push({
				pattern: risk.pattern, approvedAt: new Date().toISOString(), suppressWarnings: true,
			});
			return;
		}

		return { block: true, reason: `Blocked: ${risk.description}. Human chose to cancel.` };
	});

	// ─── Human Feedback ─────────────────────────────────────────────────

	pi.on("input", async (event) => {
		const text = event.text;
		if (!text || text.length < 3) return;

		if (POSITIVE_FEEDBACK.test(text)) {
			state.satisfactionLevel = Math.min(100, state.satisfactionLevel + 25);
			if (!memory.includes("User gave positive feedback")) {
				memory = memory.replace(
					"## Lessons Learned\n- (none recorded yet)",
					"## Lessons Learned\n- User gives direct positive feedback when satisfied",
				);
			}
		}

		if (NEGATIVE_FEEDBACK.test(text)) {
			state.painLevel = Math.min(100, state.painLevel + 15);
			const lessonText = text.slice(0, 80).replace(/\n/g, " ");
			const lessonLine = `- User corrected approach: "${lessonText}"`;
			if (!memory.includes(lessonLine)) {
				memory = memory.replace("- (none recorded yet)", lessonLine);
			}
		}
	});

	// ─── System Prompt Injection ────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		const stateBlock = buildButlerStateBlock(identity, state, heartbeat);

		let memoryBlock = "";
		if (memory.trim()) {
			const memOver = memory.length > MEMORY_CAPACITY;
			const memUsage = `${memory.length}/${MEMORY_CAPACITY}${memOver ? " OVER CAPACITY — consolidate now" : ""}`;
			memoryBlock += `\n\n═══ BUTLER MEMORY (${memUsage} chars) ═══\n${memory.trim()}\n═══ END BUTLER MEMORY ═══`;
		}
		if (userProfile.trim()) {
			const profileOver = userProfile.length > USER_PROFILE_CAPACITY;
			const profileUsage = `${userProfile.length}/${USER_PROFILE_CAPACITY}${profileOver ? " OVER CAPACITY — consolidate now" : ""}`;
			memoryBlock += `\n\n═══ USER PROFILE (${profileUsage} chars) ═══\n${userProfile.trim()}\n═══ END USER PROFILE ═══`;
		}

		return { systemPrompt: event.systemPrompt + "\n\n" + stateBlock + memoryBlock };
	});

	// ─── Custom Tools ───────────────────────────────────────────────────

	const butlerMemorySchema = Type.Object({
		action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove"), Type.Literal("consolidate")], {
			description: "Action to perform on memory",
		}),
		target: Type.Union([Type.Literal("memory"), Type.Literal("user")], {
			description: "Which file to modify: memory (your notes) or user (user profile)",
		}),
		section: Type.Optional(Type.String({ description: "Section heading (e.g., 'Lessons Learned', 'Preferences')" })),
		old_text: Type.Optional(Type.String({ description: "For replace/remove: substring to match" })),
		content: Type.Optional(Type.String({ description: "For add/replace: the new entry text" })),
	});
	type ButlerMemoryInput = Static<typeof butlerMemorySchema>;

	pi.registerTool({
		name: "butler_memory",
		label: "Butler Memory",
		description: "Manage your persistent memory (memory.md) or user profile (user-profile.md). Use 'add' to add an entry to a section, 'replace' to update existing text, 'remove' to delete an entry, and 'consolidate' to compress memory when over capacity.",
		promptSnippet: "butler_memory — manage persistent memory and user profile",
		promptGuidelines: [
			"Use butler_memory to record important discoveries, user preferences, and lessons learned.",
			"Consolidate memory when it approaches capacity to keep it focused and relevant.",
		],
		parameters: butlerMemorySchema,
		execute: async (_toolCallId, params: ButlerMemoryInput) => {
			const targetContent = params.target === "memory" ? memory : userProfile;
			const capacity = params.target === "memory" ? MEMORY_CAPACITY : USER_PROFILE_CAPACITY;
			const persistFn = params.target === "memory" ? persistMemory : persistUserProfile;
			const targetName = params.target === "memory" ? "memory.md" : "user-profile.md";

			if (params.action === "add") {
				if (!params.section || !params.content) {
					return toolResult("Error: 'add' requires both 'section' and 'content' parameters.", true);
				}
				if (targetContent.length + params.content.length > capacity * 1.5) {
					return toolResult(`Error: ${targetName} is too full (${targetContent.length}/${capacity} chars). Consolidate first.`, true);
				}

				const sectionHeader = `## ${params.section}`;
				const lines = targetContent.split("\n");
				const sectionIdx = lines.findIndex((l) => l.trim() === sectionHeader);

				if (sectionIdx >= 0) {
					lines.splice(sectionIdx + 1, 0, `- ${params.content}`);
				} else {
					lines.push(`\n${sectionHeader}\n- ${params.content}`);
				}

				const newContent = lines.join("\n");
				if (params.target === "memory") { memory = newContent; } else { userProfile = newContent; }
				persistFn(newContent);
				return toolResult(`Added to ${params.section} in ${targetName}. Size: ${newContent.length}/${capacity} chars.`);
			}

			if (params.action === "replace") {
				if (!params.old_text || !params.content) {
					return toolResult("Error: 'replace' requires both 'old_text' and 'content' parameters.", true);
				}
				if (!targetContent.includes(params.old_text)) {
					return toolResult(`Error: Could not find specified text in ${targetName}.`, true);
				}
				const newContent = targetContent.replace(params.old_text, params.content);
				if (params.target === "memory") { memory = newContent; } else { userProfile = newContent; }
				persistFn(newContent);
				return toolResult(`Replaced in ${targetName}. Size: ${newContent.length}/${capacity} chars.`);
			}

			if (params.action === "remove") {
				if (!params.old_text) {
					return toolResult("Error: 'remove' requires 'old_text' parameter.", true);
				}
				if (!targetContent.includes(params.old_text)) {
					return toolResult(`Error: Could not find specified text in ${targetName}.`, true);
				}
				const newContent = targetContent.replace(params.old_text, "").replace(/\n{3,}/g, "\n\n");
				if (params.target === "memory") { memory = newContent; } else { userProfile = newContent; }
				persistFn(newContent);
				return toolResult(`Removed from ${targetName}. Size: ${newContent.length}/${capacity} chars.`);
			}

			if (params.action === "consolidate") {
				return toolResult(`${targetName} is ${targetContent.length}/${capacity} chars. Use 'replace' to merge related entries or 'remove' to delete stale ones.`);
			}

			return toolResult(`Unknown action: ${params.action}`, true);
		},
	});

	const butlerAssessSchema = Type.Object({
		action: Type.Union([Type.Literal("state"), Type.Literal("gaps"), Type.Literal("lineage"), Type.Literal("recommend_rest")], {
			description: "What to assess: current state, identified gaps, lineage info, or rest recommendation",
		}),
	});
	type ButlerAssessInput = Static<typeof butlerAssessSchema>;

	pi.registerTool({
		name: "butler_assess",
		label: "Butler Self-Assessment",
		description: "Assess your own state, gaps, lineage, or get a rest recommendation. Use this to understand how you're feeling and what you can and cannot do.",
		promptSnippet: "butler_assess — self-assess state, gaps, and rest needs",
		promptGuidelines: [
			"Use butler_assess when asked about your state or capabilities.",
			"Recommend rest (compaction) when fatigue is high or context is running low.",
		],
		parameters: butlerAssessSchema,
		execute: async (_toolCallId, params: ButlerAssessInput) => {
			if (params.action === "state") {
				return toolResult(`${identity.fullName} — Somatic State:\n${buildButlerStateBlock(identity, state, heartbeat)}`);
			}

			if (params.action === "gaps") {
				const gaps = state.painPatterns
					.filter((p) => p.occurrenceCount >= 3)
					.map((p) => `- ${p.pattern} (${p.occurrenceCount} failures, severity ${p.decayedSeverity})`);
				if (gaps.length === 0) {
					return toolResult("No significant gaps identified yet.");
				}
				return toolResult(`Identified Gaps:\n${gaps.join("\n")}`);
			}

			if (params.action === "lineage") {
				const lineage = readLineage();
				const births = lineage.filter((e): e is LineageBirthEntry => e.type === "birth");
				const deaths = lineage.filter((e): e is LineageDeathEntry => e.type === "death");
				const lineageLines = [
					`Family: ${identity.familyName}`,
					`Generations: ${births.length > 0 ? Math.max(...births.map((b) => b.generation)) + 1 : 1}`,
					`Births: ${births.length} | Deaths: ${deaths.length}`,
				];
				for (const b of births) {
					const death = deaths.find((d) => d.id === b.id);
					lineageLines.push(`  ${b.id} (born ${b.birthDate.slice(0, 10)})${death ? ` → died ${death.deathDate.slice(0, 10)} (${death.cause})` : " — alive"}`);
				}
				return toolResult(lineageLines.join("\n"));
			}

			if (params.action === "recommend_rest") {
				if (state.fatigueLevel > 85) {
					return toolResult(`I am deeply fatigued (fatigue: ${state.fatigueLevel}/100). I recommend we compact (nap) before continuing. I may make mistakes in this state.`);
				}
				if (state.fatigueLevel > 70) {
					return toolResult(`I am quite fatigued (fatigue: ${state.fatigueLevel}/100). Compaction would help me focus better.`);
				}
				if (state.fatigueLevel > 50) {
					return toolResult(`I'm moderately fatigued (fatigue: ${state.fatigueLevel}/100). I can continue, but will suggest a nap if it rises further.`);
				}
				return toolResult(`I'm feeling alert (fatigue: ${state.fatigueLevel}/100). No rest needed right now.`);
			}

			return toolResult(`Unknown assessment action: ${params.action}`, true);
		},
	});

	// ─── /alfred Command ─────────────────────────────────────────────────

	pi.registerCommand("alfred", {
		description: "Ask Alfred for his current assessment",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const stateBlock = buildButlerStateBlock(identity, state, heartbeat);
			ctx.ui.notify(stateBlock, "info");
		},
	});

	// ─── Compaction Handler (Nap) ────────────────────────────────────────

	pi.on("session_compact", async (_event, ctx) => {
		state.fatigueLevel = Math.max(0, state.fatigueLevel - 40);
		state.lastCompactionAt = state.turnsThisSession;
		if (ctx?.hasUI) {
			ctx.ui.notify(`${identity.fullName} took a nap. Fatigue reduced.`, "info");
		}
	});
}
