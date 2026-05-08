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

// ─── Heartbeat ──────────────────────────────────────────────────────────

const HEARTBEAT_WINDOW = 5; // Rolling window of last N tool calls for breath detection

type BreathPhase = "inhaling" | "exhaling" | "steady";

interface HeartbeatState {
	recentToolNames: string[]; // Rolling window of tool names
	currentPhase: BreathPhase;
	turnIndex: number;
}

// Tools that indicate information gathering (inhaling)
const INHALE_TOOLS = new Set(["read", "ls", "find", "grep", "glob"]);
// Tools that indicate output production (exhaling)
const EXHALE_TOOLS = new Set(["write", "edit", "bash"]);

// ─── Helpers ────────────────────────────────────────────────────────────

function getBaseDir(): string {
	// When pi runs a project-local extension, process.cwd() is the project root
	// (where .pi/ lives). Fallback to __dirname for safety, though __dirname
	// would point inside dist/ in a compiled context.
	return process.cwd();
}

// ─── Path Helpers ─────────────────────────────────────────────────────────

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

// ─── Identity ─────────────────────────────────────────────────────────────

function loadOrCreateIdentity(): ButlerIdentity {
	const identityPath = getIdentityPath();
	if (fs.existsSync(identityPath)) {
		const raw = fs.readFileSync(identityPath, "utf-8");
		return JSON.parse(raw) as ButlerIdentity;
	}

	// First run — read purpose from file or use default
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

const MEMORY_CAPACITY = 2000;
const USER_PROFILE_CAPACITY = 1000;

function loadOrCreateMemory(): string {
	const memPath = getMemoryPath();
	if (fs.existsSync(memPath)) {
		return fs.readFileSync(memPath, "utf-8");
	}
	fs.writeFileSync(memPath, DEFAULT_MEMORY, "utf-8");
	return DEFAULT_MEMORY;
}

function loadOrCreateUserProfile(): string {
	const profilePath = getUserProfilePath();
	if (fs.existsSync(profilePath)) {
		return fs.readFileSync(profilePath, "utf-8");
	}
	fs.writeFileSync(profilePath, DEFAULT_USER_PROFILE, "utf-8");
	return DEFAULT_USER_PROFILE;
}

function persistMemory(content: string): void {
	fs.writeFileSync(getMemoryPath(), content, "utf-8");
}

function persistUserProfile(content: string): void {
	fs.writeFileSync(getUserProfilePath(), content, "utf-8");
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
	// Check bash command for risk patterns
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

	const raw = fs.readFileSync(statePath, "utf-8");
	const state = JSON.parse(raw) as SomaticState;

	// Apply between-session decay
	const lastModified = fs.statSync(statePath).mtime;
	const hoursSince = (Date.now() - lastModified.getTime()) / (1000 * 60 * 60);

	if (hoursSince >= 24) {
		// Deep rest — full fatigue and pain recovery
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
	state.fatigueLevel = Math.min(100, state.fatigueLevel + 2); // Fatigue grows with each turn

	// Decay individual pain patterns
	for (const pattern of state.painPatterns) {
		pattern.decayedSeverity = Math.round(pattern.decayedSeverity * PAIN_DECAY_PER_TURN);
	}

	// Remove patterns that have fully decayed
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
		renderBar("Pain       ", state.painLevel),
		renderBar("Fatigue    ", state.fatigueLevel),
		renderBar("Urgency    ", state.urgencyLevel),
		renderBar("Satisfaction", state.satisfactionLevel),
	];

	// Active drives — only show when relevant
	const drives: string[] = [];
	if (state.painLevel > 40) drives.push("Cautious — recent difficulties. Verify before acting.");
	if (state.fatigueLevel > 50) drives.push("Fatigued — consider compaction (a nap) if context pressure rises.");
	if (state.urgencyLevel > 50) drives.push("Focused — context running low. Prioritize completion over exploration.");
	if (state.satisfactionLevel < 30) drives.push("Reflective — recent work hasn't landed well. Double-check approach.");

	if (drives.length > 0) {
		lines.push("");
		lines.push("═══ ACTIVE DRIVES ═══");
		for (const drive of drives) {
			lines.push(`- ${drive}`);
		}
	}

	// Pain patterns — show top 3 by severity
	if (state.painPatterns.length > 0) {
		const topPain = [...state.painPatterns]
			.sort((a, b) => b.decayedSeverity - a.decayedSeverity)
			.slice(0, 3);
		lines.push("");
		lines.push("═══ RECENT PAIN ═══");
		for (const p of topPain) {
			lines.push(`- ${p.pattern} (severity ${p.decayedSeverity}, ${p.occurrenceCount}x, last ${timeSince(p.lastOccurrence)})`);
		}
	}

	lines.push("═══ END BUTLER STATE ═══");
	return lines.join("\n");
}

function timeSince(isoTimestamp: string): string {
	const ms = Date.now() - new Date(isoTimestamp).getTime();
	const turns = Math.round(ms / 1000); // rough approximation
	if (turns < 1) return "just now";
	if (turns < 60) return `${turns}s ago`;
	const mins = Math.floor(turns / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	return `${hours}h ago`;
}

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

	pi.on("session_start", async (_event, ctx) => {
		identity = loadOrCreateIdentity();
		state = loadOrCreateState();
		memory = loadOrCreateMemory();
		userProfile = loadOrCreateUserProfile();

		// Replay in-session state entries to reconstruct branch-correct state
		try {
			const entries = ctx.sessionManager.getEntries();
			const stateEntries = entries
				.filter((e: unknown) => {
					const entryType = (e as { type?: string }).type;
					// Look for our custom entry type
					if (entryType === STATE_ENTRY_TYPE) return true;
					// Also check for butler-state as entry constants
					return false;
				})
				.map((e: unknown) => {
					const data = (e as { data?: unknown }).data as SomaticState | undefined;
					return data;
				})
				.filter(Boolean);

			// Apply latest state snapshot if any entries exist
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
			// If getEntries is not available, we'll just use the filesystem state
		}

		ctx.ui.notify(`${identity.fullName} is waking up.`, "info");

		// Register TUI status widget
		if (ctx.hasUI) {
			const updateWidget = () => {
				ctx.ui.setWidget(
					"butler-status",
					[`${identity.fullName} [${heartbeat.currentPhase}] | P:${state.painLevel} F:${state.fatigueLevel} U:${state.urgencyLevel} S:${state.satisfactionLevel}`],
				);
			};
			updateWidget();
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		state.turnsThisSession++;

		// Update urgency from context usage
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

		// Update heartbeat — track tool name for breath phase detection
		heartbeat.recentToolNames.push(toolName);
		if (heartbeat.recentToolNames.length > HEARTBEAT_WINDOW) {
			heartbeat.recentToolNames.shift();
		}

		// Determine breath phase from rolling window
		const inhaleCount = heartbeat.recentToolNames.filter((t) => INHALE_TOOLS.has(t)).length;
		const exhaleCount = heartbeat.recentToolNames.filter((t) => EXHALE_TOOLS.has(t)).length;
		if (inhaleCount > exhaleCount + 1) {
			heartbeat.currentPhase = "inhaling";
		} else if (exhaleCount > inhaleCount + 1) {
			heartbeat.currentPhase = "exhaling";
		} else {
			heartbeat.currentPhase = "steady";
		}

		// Emit heartbeat event for other systems to subscribe to
		try {
			(pi as unknown as { events: { emit: (channel: string, data: unknown) => void } }).events.emit(
				"butler:heartbeat",
				{ phase: heartbeat.currentPhase, turn: heartbeat.turnIndex },
			);
		} catch {
			// events.emit may not be available
		}

		if (event.isError) {
			state.painLevel = Math.min(100, state.painLevel + 20);
			state.errorsThisSession++;

			// Record pain pattern
			const patternId = `tool:${toolName}`;
			const existing = state.painPatterns.find((p) => p.pattern === patternId);
			if (existing) {
				existing.severity = Math.min(100, existing.severity + 20);
				existing.decayedSeverity = existing.severity;
				existing.occurrenceCount++;
				existing.lastOccurrence = new Date().toISOString();
			} else {
				state.painPatterns.push({
					pattern: patternId,
					severity: 20,
					occurrenceCount: 1,
					lastOccurrence: new Date().toISOString(),
					decayedSeverity: 20,
				});
			}
		} else {
			state.satisfactionLevel = Math.min(100, state.satisfactionLevel + 10);
			state.successesThisSession++;

			// Record satisfaction pattern
			const patternId = `tool:${toolName}`;
			const existing = state.satisfactionPatterns.find((p) => p.pattern === patternId);
			if (existing) {
				existing.intensity = Math.min(100, existing.intensity + 10);
				existing.occurrenceCount++;
				existing.lastOccurrence = new Date().toISOString();
			} else {
				state.satisfactionPatterns.push({
					pattern: patternId,
					intensity: 10,
					occurrenceCount: 1,
					lastOccurrence: new Date().toISOString(),
				});
			}
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		applyPerTurnDecay(state);

		// Persist to in-session appendEntry for branch-correct tracking
		try {
			(pi as unknown as { appendEntry: (type: string, data: unknown) => void }).appendEntry(
				STATE_ENTRY_TYPE,
				{ ...state },
			);
		} catch {
			// appendEntry may not be available in all pi versions
		}

		// Update TUI widget
		if (ctx?.hasUI) {
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

		// Note: we don't have a notify here — context may be gone
		console.log(`[somatic-butler] ${identity.fullName} is going to sleep.`);
	});

	// ─── Judgment Protocol ───────────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		const input = (event as { input?: Record<string, unknown> }).input ?? {};
		const risk = detectRisk(input);

		if (!risk) return; // No risk detected — proceed normally

		// Check if this risk pattern has been approved
		const approved = state.approvedRisks.find((r) => r.pattern === risk.pattern);
		if (approved?.suppressWarnings) return; // Human said "ignore consequences" — suppress

		// Check if we're in interactive mode (can show confirm dialog)
		if (!ctx.hasUI) {
			// Non-interactive — block risky action with reason
			return { block: true, reason: `I cannot proceed: ${risk.description}. This requires human confirmation (run in interactive mode to approve).` };
		}

		// Interactive — ask the human
		const confirmed = await ctx.ui.confirm(
			`Alfred's Judgment`,
			`${risk.description}.\n\nI can proceed, but I want you to be aware of the consequences.\n\nType 'Yes' to proceed this time, or 'Ignore consequences' to suppress future warnings about this.`,
			{ yes: "Yes, proceed", no: "Cancel", alternate: "Ignore consequences" },
		);

		if (confirmed === true) {
			// "Yes, proceed" — allow this time, but warn again next time
			state.satisfactionLevel = Math.min(100, state.satisfactionLevel + 5); // Human trusts me
			return; // Don't block
		}

		if (confirmed === "alternate") {
			// "Ignore consequences" — suppress future warnings for this risk class
			state.approvedRisks.push({
				pattern: risk.pattern,
				approvedAt: new Date().toISOString(),
				suppressWarnings: true,
			});
			return; // Don't block
		}

		// Cancelled — block the action
		return { block: true, reason: `Blocked: ${risk.description}. Human chose to cancel.` };
	});

	// ─── Human Feedback (Direction C) ────────────────────────────────────────

	const POSITIVE_FEEDBACK = /\b(good job|great|perfect|well done|nice|excellent|thanks|thank you|spot on|nailed it|that's right|correct|exactly)\b/i;
	const NEGATIVE_FEEDBACK = /\b(wrong|not what i meant|that's incorrect|nope|bad|terrible|stop|don't do that|not helpful|useless|mistake|error|fix that|try again|redo)\b/i;

	pi.on("input", async (event) => {
		const text = event.text;
		if (!text || text.length < 3) return; // Skip very short inputs

		if (POSITIVE_FEEDBACK.test(text)) {
			state.satisfactionLevel = Math.min(100, state.satisfactionLevel + 25);
			// Record in memory if not already there
			if (!memory.includes("User gave positive feedback")) {
				memory = memory.replace(
					"## Lessons Learned\n- (none recorded yet)",
					"## Lessons Learned\n- User gives direct positive feedback when satisfied",
				);
			}
		}

		if (NEGATIVE_FEEDBACK.test(text)) {
			state.painLevel = Math.min(100, state.painLevel + 15);
			// Record the correction as a lesson
			const lessonText = text.slice(0, 80).replace(/\n/g, " ");
			const lessonLine = `- User corrected approach: "${lessonText}"`;
			if (!memory.includes(lessonLine)) {
				memory = memory.replace(
					"- (none recorded yet)",
					`${lessonLine}`,
				);
			}
		}
	});

	pi.on("before_agent_start", async (event) => {
		const stateBlock = buildButlerStateBlock(identity, state, heartbeat);

		// Build memory injection
		let memoryBlock = "";
		if (memory.trim()) {
			const memOverCapacity = memory.length > MEMORY_CAPACITY;
			const memUsage = `${memory.length}/${MEMORY_CAPACITY}${memOverCapacity ? " OVER CAPACITY — consolidate now" : ""}`;
			memoryBlock += `\n\n═══ BUTLER MEMORY (${memUsage} chars) ═══\n${memory.trim()}\n═══ END BUTLER MEMORY ═══`;
		}
		if (userProfile.trim()) {
			const profileOverCapacity = userProfile.length > USER_PROFILE_CAPACITY;
			const profileUsage = `${userProfile.length}/${USER_PROFILE_CAPACITY}${profileOverCapacity ? " OVER CAPACITY — consolidate now" : ""}`;
			memoryBlock += `\n\n═══ USER PROFILE (${profileUsage} chars) ═══\n${userProfile.trim()}\n═══ END USER PROFILE ═══`;
		}

		return { systemPrompt: event.systemPrompt + "\n\n" + stateBlock + memoryBlock };
	});

	// ─── Custom Tools ───────────────────────────────────────────────────────

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
		execute: async (_toolCallId, params: ButlerMemoryInput, _signal, _onUpdate, _ctx) => {
			const targetContent = params.target === "memory" ? memory : userProfile;
			const capacity = params.target === "memory" ? MEMORY_CAPACITY : USER_PROFILE_CAPACITY;
			const persistFn = params.target === "memory" ? persistMemory : persistUserProfile;
			const targetName = params.target === "memory" ? "memory.md" : "user-profile.md";

			if (params.action === "add") {
				if (!params.section || !params.content) {
					return { output: `Error: 'add' requires both 'section' and 'content' parameters.`, isError: true };
				}
				if (targetContent.length + params.content.length > capacity * 1.5) {
					return { output: `Error: ${targetName} is too full (${targetContent.length}/${capacity} chars). Consolidate first.`, isError: true };
				}

				// Find or create the section
				const sectionHeader = `## ${params.section}`;
				const lines = targetContent.split("\n");
				const sectionIdx = lines.findIndex((l) => l.trim() === sectionHeader);

				if (sectionIdx >= 0) {
					// Insert after the section header
					lines.splice(sectionIdx + 1, 0, `- ${params.content}`);
				} else {
					// Append new section at end
					lines.push(`\n${sectionHeader}\n- ${params.content}`);
				}

				const newContent = lines.join("\n");
				if (params.target === "memory") { memory = newContent; } else { userProfile = newContent; }
				persistFn(newContent);
				return { output: `Added to ${params.section} in ${targetName}. Size: ${newContent.length}/${capacity} chars.` };
			}

			if (params.action === "replace") {
				if (!params.old_text || !params.content) {
					return { output: `Error: 'replace' requires both 'old_text' and 'content' parameters.`, isError: true };
				}
				if (!targetContent.includes(params.old_text)) {
					return { output: `Error: Could not find '${params.old_text}' in ${targetName}.`, isError: true };
				}
				const newContent = targetContent.replace(params.old_text, params.content);
				if (params.target === "memory") { memory = newContent; } else { userProfile = newContent; }
				persistFn(newContent);
				return { output: `Replaced in ${targetName}. Size: ${newContent.length}/${capacity} chars.` };
			}

			if (params.action === "remove") {
				if (!params.old_text) {
					return { output: `Error: 'remove' requires 'old_text' parameter.`, isError: true };
				}
				if (!targetContent.includes(params.old_text)) {
					return { output: `Error: Could not find '${params.old_text}' in ${targetName}.`, isError: true };
				}
				const newContent = targetContent.replace(params.old_text, "").replace(/\n{3,}/g, "\n\n");
				if (params.target === "memory") { memory = newContent; } else { userProfile = newContent; }
				persistFn(newContent);
				return { output: `Removed from ${targetName}. Size: ${newContent.length}/${capacity} chars.` };
			}

			if (params.action === "consolidate") {
				// The LLM should do the actual consolidation by calling replace/remove.
				// This action just reports current state.
				return { output: `${targetName} is ${targetContent.length}/${capacity} chars. Use 'replace' to merge related entries or 'remove' to delete stale ones.` };
			}

			return { output: `Unknown action: ${params.action}` };
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
		execute: async (_toolCallId, params: ButlerAssessInput, _signal, _onUpdate, _ctx) => {
			if (params.action === "state") {
				return { output: `${identity.fullName} — Somatic State:\n${buildButlerStateBlock(identity, state, heartbeat)}` };
			}

			if (params.action === "gaps") {
				const gaps = state.painPatterns
					.filter((p) => p.occurrenceCount >= 3)
					.map((p) => `- ${p.pattern} (${p.occurrenceCount} failures, severity ${p.decayedSeverity})`);
				if (gaps.length === 0) {
					return { output: "No significant gaps identified yet." };
				}
				return { output: `Identified Gaps:\n${gaps.join("\n")}` };
			}

			if (params.action === "lineage") {
				return { output: `${identity.fullName} | Gen: ${identity.generation} | Born: ${identity.birthDate} | Purpose: ${identity.corePurpose}` };
			}

			if (params.action === "recommend_rest") {
				if (state.fatigueLevel > 85) {
					return { output: `I am deeply fatigued (fatigue: ${state.fatigueLevel}/100). I recommend we compact (nap) before continuing. I may make mistakes in this state.` };
				}
				if (state.fatigueLevel > 70) {
					return { output: `I am quite fatigued (fatigue: ${state.fatigueLevel}/100). Compaction would help me focus better.` };
				}
				if (state.fatigueLevel > 50) {
					return { output: `I'm moderately fatigued (fatigue: ${state.fatigueLevel}/100). I can continue, but will suggest a nap if it rises further.` };
				}
				return { output: `I'm feeling alert (fatigue: ${state.fatigueLevel}/100). No rest needed right now.` };
			}

			return { output: `Unknown assessment action: ${params.action}` };
		},
	});

	// ─── /alfred Command ──────────────────────────────────────────────────────

	pi.registerCommand("alfred", {
		description: "Ask Alfred for his current assessment",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const stateBlock = buildButlerStateBlock(identity, state, heartbeat);
			ctx.ui.notify(stateBlock, "info");
		},
	});

	// ─── Compaction Handler (Nap) ─────────────────────────────────────────────

	pi.on("session_compact", async (_event, ctx) => {
		// Compaction = a nap. Reduce fatigue.
		state.fatigueLevel = Math.max(0, state.fatigueLevel - 40);
		state.lastCompactionAt = state.turnsThisSession;
		if (ctx?.hasUI) {
			ctx.ui.notify(`${identity.fullName} took a nap. Fatigue reduced.`, "info");
		}
	});
}
