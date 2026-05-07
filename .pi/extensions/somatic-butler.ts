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

// ─── Helpers ────────────────────────────────────────────────────────────

function getBaseDir(): string {
	// When pi runs a project-local extension, process.cwd() is the project root
	// (where .pi/ lives). Fallback to __dirname for safety, though __dirname
	// would point inside dist/ in a compiled context.
	return process.cwd();
}

// ─── Helpers ────────────────────────────────────────────────────────────

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

// ─── Extension ───────────────────────────────────────────────────────────

export default function somaticButlerExtension(pi: ExtensionAPI) {
	let identity: ButlerIdentity;
	let state: SomaticState;

	pi.on("session_start", async (_event, ctx) => {
		identity = loadOrCreateIdentity();
		state = loadOrCreateState();

		ctx.ui.notify(`${identity.fullName} is waking up.`, "info");
	});

	pi.on("session_shutdown", async () => {
		persistIdentity(identity);
		persistState(state);

		// Note: we don't have a notify here — context may be gone
		console.log(`[somatic-butler] ${identity.fullName} is going to sleep.`);
	});
}
