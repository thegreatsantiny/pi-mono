import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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
}

// ─── System Prompt Injection ───────────────────────────────────────────

function renderBar(label: string, value: number, max = 100): string {
	const width = 10;
	const filled = Math.round((value / max) * width);
	const empty = width - filled;
	const bar = "█".repeat(filled) + "░".repeat(empty);
	return `${label}: ${bar} ${value}/${max}`;
}

function buildButlerStateBlock(identity: ButlerIdentity, state: SomaticState): string {
	const lines: string[] = [
		"═══ BUTLER STATE ═══",
		`Name: ${identity.fullName} | Gen: ${identity.generation} | Session turn: ${state.turnsThisSession}`,
		`Purpose: ${identity.corePurpose}`,
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

	pi.on("session_start", async (_event, ctx) => {
		identity = loadOrCreateIdentity();
		state = loadOrCreateState();

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
		if (event.isError) {
			state.painLevel = Math.min(100, state.painLevel + 20);
			state.errorsThisSession++;
			// TODO: record pain pattern
		} else {
			state.satisfactionLevel = Math.min(100, state.satisfactionLevel + 10);
			state.successesThisSession++;
			// TODO: record satisfaction pattern
		}
	});

	pi.on("turn_end", async () => {
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
	});

	pi.on("session_shutdown", async () => {
		persistIdentity(identity);
		persistState(state);

		// Note: we don't have a notify here — context may be gone
		console.log(`[somatic-butler] ${identity.fullName} is going to sleep.`);
	});

	pi.on("before_agent_start", async (event) => {
		const stateBlock = buildButlerStateBlock(identity, state);
		return { systemPrompt: event.systemPrompt + "\n\n" + stateBlock };
	});
}
