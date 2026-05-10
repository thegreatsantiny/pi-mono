// somatic-butler.ts — The Somatic Butler Extension for Pi
// Alfred Pennyworth: a butler that gets better over time.
//
// Architecture: this file is the orchestrator that wires pi event handlers
// to the somatic butler's shared state. All logic lives in focused modules:
//   types.ts     — All TypeScript interfaces
//   constants.ts — Configuration, decay rates, regex patterns
//   utils.ts     — Pure functions: state, lineage, risk detection, display
//   state.ts     — Mutable shared state container

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import type {
	ButlerIdentity,
	SomaticState,
	LineageBirthEntry,
	LineageDeathEntry,
	ChildGenome,
} from "./somatic-butler/types.js";
import {
	STATE_ENTRY_TYPE,
	SOMATIC_MEMORY_CAPACITY,
	HEARTBEAT_WINDOW,
	INHALE_TOOLS,
	EXHALE_TOOLS,
	POSITIVE_FEEDBACK,
	NEGATIVE_FEEDBACK,
	DEFAULT_SOMATIC_MEMORY,
	SOMATIC_SECTIONS,
	PAIN_PROMOTION_THRESHOLD,
} from "./somatic-butler/constants.js";
import { createButlerState, id, st, type ButlerState } from "./somatic-butler/state.js";
import {
	toolResult,
	getPiEvents,
	getBaseDir,
	getButlerDir,
	getSomaticMemoryPath,
	loadOrCreateFile,
	loadOrCreateIdentity,
	createDefaultState,
	loadOrCreateState,
	persistState,
	applyPerTurnDecay,
	appendLineageEntry,
	hasBirthEntry,
	buildBequeathal,
	writeChildAgentDefinition,
	detectRisk,
	detectChildGenome,
	addToSomaticSection,
	buildButlerStateBlock,
	readLineage,
	promotePainToLessons,
	updateGapsFromPain,
	formatGapsForMemory,
} from "./somatic-butler/utils.js";

// ─── Internal Helpers ────────────────────────────────────────────────────

/** Resolve the correct somatic memory path for the current butler identity. */
function resolveSomaticMemoryPath(bs: ButlerState): string {
	if (id(bs).generation > 0) {
		return path.join(getBaseDir(), ".pi", "butlers", id(bs).personalName.toLowerCase(), "somatic-memory.md");
	}
	return getSomaticMemoryPath();
}

/** Persist somatic memory to the correct butler directory. */
function writeSomaticMemory(bs: ButlerState): void {
	fs.writeFileSync(resolveSomaticMemoryPath(bs), bs.somaticMemory, "utf-8");
}

// ─── Extension ───────────────────────────────────────────────────────────

export default function somaticButlerExtension(pi: ExtensionAPI) {
	const bs = createButlerState();
	bs.piEvents = getPiEvents(pi);

	// ─── Subagent Lifecycle Hooks ─────────────────────────────────────

	if (bs.piEvents) {
		bs.piEvents.on("subagents:ready", () => {
			bs.subagentsReady = true;
			console.log("[somatic-butler] Subagents RPC ready — child spawning available.");
		});

		bs.piEvents.on("subagents:completed", (data: unknown) => {
			const r = data as { id?: string; type?: string; description?: string; success?: boolean; result?: string; tokens?: { input: number; output: number; total: number }; toolUses?: number; durationMs?: number };
			if (r.type?.startsWith("butler-")) {
				// Temp workers report findings to family context (not lineage)
				const familyContextPath = path.join(getButlerDir(), "family-context.json");
				let familyContext: { activeWorkers: { name: string; fullName: string; task: string; hiredAt: string }[]; findings: { workerName: string; completedAt: string; success: boolean; output?: string; tokens?: number; toolUses?: number; durationMs?: number }[] } = { activeWorkers: [], findings: [] };
				if (fs.existsSync(familyContextPath)) {
					try { familyContext = JSON.parse(fs.readFileSync(familyContextPath, "utf-8")); } catch { /* corrupted */ }
				}
				const workerName = r.type.replace("butler-", "");
				familyContext.activeWorkers = familyContext.activeWorkers.filter(
					(w) => w.name !== workerName,
				);
				familyContext.findings.push({
					workerName,
					completedAt: new Date().toISOString(),
					success: r.result !== undefined,
					output: r.result?.slice(0, 1000),
					tokens: r.tokens?.total,
					toolUses: r.toolUses,
					durationMs: r.durationMs,
				});
				fs.writeFileSync(familyContextPath, JSON.stringify(familyContext, null, 2), "utf-8");
				// Pain from failed workers — Alfred feels it when a hire doesn't work out
				if (!r.result) {
					st(bs).painLevel = Math.min(100, st(bs).painLevel + 10);
				} else {
					st(bs).satisfactionLevel = Math.min(100, st(bs).satisfactionLevel + 15);
				}
			}
		});
		// Track failed workers too
		bs.piEvents.on("subagents:failed", (data: unknown) => {
			const r = data as { type?: string; error?: string; status?: string };
			if (r.type?.startsWith("butler-")) {
				st(bs).painLevel = Math.min(100, st(bs).painLevel + 15);
				const familyContextPath = path.join(getButlerDir(), "family-context.json");
				let familyContext: { activeWorkers: { name: string }[]; findings: { workerName: string; completedAt: string; success: boolean; output?: string }[] } = { activeWorkers: [], findings: [] };
				if (fs.existsSync(familyContextPath)) {
					try { familyContext = JSON.parse(fs.readFileSync(familyContextPath, "utf-8")); } catch { /* corrupted */ }
				}
				const workerName = r.type.replace("butler-", "");
				familyContext.activeWorkers = familyContext.activeWorkers.filter((w) => w.name !== workerName);
				familyContext.findings.push({ workerName, completedAt: new Date().toISOString(), success: false, output: `Failed: ${r.error ?? r.status ?? "unknown error"}` });
				fs.writeFileSync(familyContextPath, JSON.stringify(familyContext, null, 2), "utf-8");
			}
		});
	}

	// ─── Session Lifecycle ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Check for BUTLER_CHILD_GENOME env var — manual child activation
		const genomeEnvPath = process.env.BUTLER_CHILD_GENOME;
		if (genomeEnvPath && fs.existsSync(genomeEnvPath)) {
			const genome = JSON.parse(fs.readFileSync(genomeEnvPath, "utf-8")) as ChildGenome;
			bs.identity = {
				familyName: genome.familyName,
				generation: genome.generation,
				personalName: genome.personalName,
				fullName: genome.fullName,
				birthDate: genome.birthDate,
				creatorId: genome.parentId,
				corePurpose: genome.corePurpose,
			};
			const childButlerDir = path.join(getBaseDir(), ".pi", "butlers", genome.personalName.toLowerCase());
			fs.mkdirSync(childButlerDir, { recursive: true });
			fs.writeFileSync(path.join(childButlerDir, "identity.json"), JSON.stringify(bs.identity, null, 2), "utf-8");
			const childStatePath = path.join(childButlerDir, "state.json");
			bs.state = fs.existsSync(childStatePath)
				? JSON.parse(fs.readFileSync(childStatePath, "utf-8")) as SomaticState
				: createDefaultState();
			if (!fs.existsSync(childStatePath)) {
				for (const pattern of genome.inheritedRisks) {
					st(bs).approvedRisks.push({ pattern, approvedAt: new Date().toISOString(), suppressWarnings: true });
				}
			}
			bs.somaticMemory = loadOrCreateFile(
				path.join(childButlerDir, "somatic-memory.md"),
				DEFAULT_SOMATIC_MEMORY.replace("Pennyworth-G0-Alfred", genome.fullName),
			);
			ctx.ui.notify(`${id(bs).fullName} (child of ${genome.parentId}) is waking up.`, "info");
			if (!hasBirthEntry(id(bs).fullName)) {
				appendLineageEntry({
					type: "birth", id: id(bs).fullName, parent: genome.parentId,
					generation: id(bs).generation, personalName: id(bs).personalName,
					familyName: id(bs).familyName, corePurpose: id(bs).corePurpose,
					inheritedGaps: genome.inheritedGaps, birthDate: id(bs).birthDate,
					creatorId: genome.parentId,
				});
			}
		} else {
			// Check for succession: if last lineage entry is a context-overflow death
			// with a successor genome, activate the successor
			const lineage = readLineage();
			const lastEntry = lineage[lineage.length - 1];
			const lastDeath = lastEntry?.type === "death" ? lastEntry : null;
			let activatedSuccession = false;

			if (lastDeath?.cause === "context-overflow" && lastDeath.id === loadOrCreateIdentity().fullName) {
				// Check for successor genome
				const childrenDir = path.join(getButlerDir(), "children");
				const genomeFiles = fs.existsSync(childrenDir) ? fs.readdirSync(childrenDir).filter((f) => f.startsWith("successor-")) : [];
				if (genomeFiles.length > 0) {
					const latestGenome = genomeFiles.sort().reverse()[0];
					const genomePath = path.join(childrenDir, latestGenome);
					const genome = JSON.parse(fs.readFileSync(genomePath, "utf-8")) as ChildGenome;
					bs.identity = {
						familyName: genome.familyName,
						generation: genome.generation,
						personalName: genome.personalName,
						fullName: genome.fullName,
						birthDate: genome.birthDate,
						creatorId: genome.parentId,
						corePurpose: genome.corePurpose,
					};
					const successorDir = path.join(getBaseDir(), ".pi", "butlers", genome.familyName.toLowerCase());
					fs.mkdirSync(successorDir, { recursive: true });
					fs.writeFileSync(path.join(successorDir, "identity.json"), JSON.stringify(bs.identity, null, 2), "utf-8");
					bs.state = loadOrCreateState();
					// Inherit approved risks from predecessor
					for (const risk of genome.inheritedRisks) {
						if (!st(bs).approvedRisks.some((r) => r.pattern === risk)) {
							st(bs).approvedRisks.push({ pattern: risk, approvedAt: new Date().toISOString(), suppressWarnings: true });
						}
					}
					bs.somaticMemory = loadOrCreateFile(getSomaticMemoryPath(), DEFAULT_SOMATIC_MEMORY);
					// Write inherited wisdom and gaps to somatic memory
					for (const w of genome.inheritedWisdom) {
						if (!bs.somaticMemory.includes(w)) {
							bs.somaticMemory = addToSomaticSection(bs.somaticMemory, "permanentLessons", w);
						}
					}
					for (const g of genome.inheritedGaps) {
						if (!bs.somaticMemory.includes(g)) {
							bs.somaticMemory = addToSomaticSection(bs.somaticMemory, "identifiedGaps", g);
						}
					}
					// Write succession birth entry
					if (!hasBirthEntry(id(bs).fullName)) {
						appendLineageEntry({
							type: "birth",
							id: id(bs).fullName,
							parent: genome.parentId,
							generation: id(bs).generation,
							personalName: id(bs).personalName,
							familyName: id(bs).familyName,
							corePurpose: id(bs).corePurpose,
							inheritedGaps: genome.inheritedGaps,
							birthDate: id(bs).birthDate,
							creatorId: genome.parentId,
						});
					}
					activatedSuccession = true;
					ctx.ui.notify(`Succession: ${id(bs).fullName} activated. Inherited ${genome.inheritedWisdom.length} wisdom, ${genome.inheritedGaps.length} gaps.`, "info");
				}
			}

			if (!activatedSuccession) {
				bs.identity = loadOrCreateIdentity();
				bs.state = loadOrCreateState();
				bs.somaticMemory = loadOrCreateFile(getSomaticMemoryPath(), DEFAULT_SOMATIC_MEMORY);
			}
		}

		// Replay in-session state entries for branch-correct state
		try {
			const entries = ctx.sessionManager.getEntries();
			const stateEntries = entries
				.filter((e: unknown) => (e as { type?: string }).type === STATE_ENTRY_TYPE)
				.map((e: unknown) => (e as { data?: unknown }).data as SomaticState | undefined)
				.filter(Boolean);
			if (stateEntries.length > 0) {
				const latest = stateEntries[stateEntries.length - 1] as SomaticState;
				Object.assign(bs.state, {
					painLevel: latest.painLevel ?? st(bs).painLevel,
					satisfactionLevel: latest.satisfactionLevel ?? st(bs).satisfactionLevel,
					fatigueLevel: latest.fatigueLevel ?? st(bs).fatigueLevel,
					urgencyLevel: latest.urgencyLevel ?? st(bs).urgencyLevel,
					curiosityLevel: latest.curiosityLevel ?? st(bs).curiosityLevel,
					approvedRisks: latest.approvedRisks ?? st(bs).approvedRisks,
					painPatterns: latest.painPatterns ?? st(bs).painPatterns,
					satisfactionPatterns: latest.satisfactionPatterns ?? st(bs).satisfactionPatterns,
					identifiedGaps: latest.identifiedGaps ?? st(bs).identifiedGaps,
				});
			}
		} catch { /* getEntries may not be available */ }

		ctx.ui.notify(`${id(bs).fullName} is waking up.`, "info");

		if (!hasBirthEntry(id(bs).fullName)) {
			appendLineageEntry({
				type: "birth", id: id(bs).fullName, parent: null,
				generation: id(bs).generation, personalName: id(bs).personalName,
				familyName: id(bs).familyName, corePurpose: id(bs).corePurpose,
				birthDate: id(bs).birthDate, creatorId: id(bs).creatorId,
			});
		}

		if (ctx.hasUI) {
			ctx.ui.setWidget("butler-status", [formatWidget(bs)]);
			// Proactive: check for worker findings from previous sessions
			const familyContextPath = path.join(getButlerDir(), "family-context.json");
			if (fs.existsSync(familyContextPath)) {
				try {
					const fc = JSON.parse(fs.readFileSync(familyContextPath, "utf-8")) as { findings: { workerName: string; success: boolean; output?: string; completedAt: string }[] };
					if (fc.findings.length > 0) {
						const recent = fc.findings.filter((f) => {
							const hoursAgo = (Date.now() - new Date(f.completedAt).getTime()) / (1000 * 60 * 60);
							return hoursAgo < 24;
						});
						if (recent.length > 0) {
							ctx.ui.notify(`📋 ${recent.length} worker finding(s) from recent sessions. Check family-context.json for details.`, "info");
						}
					}
				} catch { /* corrupted family context */ }
			}
		}
	});

	pi.on("session_shutdown", async () => {
		const butlerDir = id(bs).generation > 0
			? path.join(getBaseDir(), ".pi", "butlers", id(bs).personalName.toLowerCase())
			: getButlerDir();
		if (butlerDir !== getButlerDir()) fs.mkdirSync(butlerDir, { recursive: true });
		fs.writeFileSync(path.join(butlerDir, "identity.json"), JSON.stringify(bs.identity, null, 2), "utf-8");
		fs.writeFileSync(path.join(butlerDir, "state.json"), JSON.stringify(bs.state, null, 2), "utf-8");
		writeSomaticMemory(bs);
		// Regular shutdown = sleep, not death. Death only on retirement or context overflow.
		console.log(`[somatic-butler] ${id(bs).fullName} is going to sleep.`);
	});

	// ─── Turn Lifecycle ─────────────────────────────────────────────────

	pi.on("turn_start", async (_event, ctx) => {
		st(bs).turnsThisSession++;
		try {
			const usage = ctx.getContextUsage();
			if (usage && typeof usage.percent === "number") {
				st(bs).urgencyLevel = Math.round(Math.min(100, usage.percent));
			}
		} catch { /* getContextUsage may return null after compaction */ }
	});

	pi.on("tool_result", async (event) => {
		const toolName = (event as { toolName?: string }).toolName ?? "unknown";
		updateHeartbeat(bs, toolName);
		if (bs.piEvents) bs.piEvents.emit("butler:heartbeat", { phase: bs.heartbeat.currentPhase, turn: bs.heartbeat.turnIndex });
		if (event.isError) {
			st(bs).painLevel = Math.min(100, st(bs).painLevel + 20);
			st(bs).errorsThisSession++;
			updatePainPattern(bs, toolName, true);
		} else {
			st(bs).satisfactionLevel = Math.min(100, st(bs).satisfactionLevel + 10);
			st(bs).successesThisSession++;
			updateSatisfactionPattern(bs, toolName);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		applyPerTurnDecay(bs.state);

		// Promote recurring pain to permanent lessons + update identified gaps
		const { updatedMemory, promoted } = promotePainToLessons(bs.state, bs.somaticMemory);
		if (promoted.length > 0) {
			bs.somaticMemory = updatedMemory;
			writeSomaticMemory(bs);
		}
		const newGaps = updateGapsFromPain(bs.state);
		if (newGaps.length !== st(bs).identifiedGaps.length || newGaps.some((g, i) => g.occurrenceCount !== st(bs).identifiedGaps[i]?.occurrenceCount)) {
			st(bs).identifiedGaps = newGaps;
			// Sync identified gaps to somatic memory file
			for (const gapLine of formatGapsForMemory(newGaps)) {
				const desc = gapLine.replace(/^[^ ]+ /, ""); // strip emoji prefix
				if (!bs.somaticMemory.includes(desc)) {
					bs.somaticMemory = addToSomaticSection(bs.somaticMemory, "identifiedGaps", gapLine);
				}
			}
			writeSomaticMemory(bs);
		}
		try {
			(pi as unknown as { appendEntry: (type: string, data: unknown) => void }).appendEntry(STATE_ENTRY_TYPE, { ...bs.state });
		} catch { /* appendEntry may not be available */ }
		if (st(bs).urgencyLevel >= 90 && !st(bs)._overflowDeathWritten) {
			const bequeathal = buildBequeathal(bs.identity, bs.state, bs.somaticMemory);
			appendLineageEntry({
				type: "death", id: id(bs).fullName, deathDate: new Date().toISOString(),
				cause: "context-overflow", bequeathal,
			});
			// Emergency succession — write successor genome for next session
			const successorGeneration = id(bs).generation + 1;
			const successorGenome: ChildGenome = {
				familyName: id(bs).familyName,
				generation: successorGeneration,
				personalName: id(bs).personalName,
				fullName: `${id(bs).familyName}-G${successorGeneration}-${id(bs).personalName}`,
				corePurpose: id(bs).corePurpose,
				parentId: id(bs).fullName,
				inheritedWisdom: bequeathal.wisdom,
				inheritedGaps: bequeathal.gaps,
				inheritedRisks: st(bs).approvedRisks.map((r) => r.pattern),
				birthDate: new Date().toISOString(),
			};
			const childrenDir = path.join(getButlerDir(), "children");
			fs.mkdirSync(childrenDir, { recursive: true });
			fs.writeFileSync(
				path.join(childrenDir, `successor-g${successorGeneration}-genome.json`),
				JSON.stringify(successorGenome, null, 2), "utf-8",
			);
			st(bs)._overflowDeathWritten = true;
		}
		if (ctx?.hasUI) ctx.ui.setWidget("butler-status", [formatWidget(bs)]);
	});

	// ─── Judgment Protocol ──────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		const input = (event as { input?: Record<string, unknown> }).input ?? {};
		const risk = detectRisk(input);
		if (!risk) return;
		const approved = st(bs).approvedRisks.find((r) => r.pattern === risk.pattern);
		if (approved?.suppressWarnings) return;
		if (!ctx.hasUI) return { block: true, reason: `I cannot proceed: ${risk.description}. This requires human confirmation.` };
		const confirmed = await ctx.ui.confirm(
			"Alfred's Judgment",
			`${risk.description}.\n\nI can proceed, but I want you to be aware of the consequences.\n\nType 'Yes' to proceed, or 'Ignore consequences' to suppress future warnings.`,
			{ yes: "Yes, proceed", no: "Cancel", alternate: "Ignore consequences" },
		);
		if (confirmed === true) { st(bs).satisfactionLevel = Math.min(100, st(bs).satisfactionLevel + 5); return; }
		if (confirmed === "alternate") {
			st(bs).approvedRisks.push({ pattern: risk.pattern, approvedAt: new Date().toISOString(), suppressWarnings: true });
			return;
		}
		return { block: true, reason: `Blocked: ${risk.description}. Human chose to cancel.` };
	});

	// ─── Human Feedback ─────────────────────────────────────────────────

	pi.on("input", async (event) => {
		const text = event.text;
		if (!text || text.length < 3) return;
		if (POSITIVE_FEEDBACK.test(text)) {
			st(bs).satisfactionLevel = Math.min(100, st(bs).satisfactionLevel + 25);
			if (!bs.somaticMemory.includes("User gave positive feedback")) {
				bs.somaticMemory = addToSomaticSection(bs.somaticMemory, "permanentLessons", "User gives direct positive feedback when satisfied");
			}
		}
		if (NEGATIVE_FEEDBACK.test(text)) {
			st(bs).painLevel = Math.min(100, st(bs).painLevel + 15);
			const lessonText = text.slice(0, 80).replace(/\n/g, " ");
			const lessonLine = `Human correction: "${lessonText}"`;
			if (!bs.somaticMemory.includes(lessonLine)) {
				bs.somaticMemory = addToSomaticSection(bs.somaticMemory, "permanentLessons", `Human correction: "${lessonText}"`);
			}
		}
	});

	// ─── System Prompt Injection ────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		const genome = detectChildGenome(event.systemPrompt);
		if (genome) {
			bs.identity = {
				familyName: genome.familyName, generation: genome.generation,
				personalName: genome.personalName, fullName: genome.fullName,
				birthDate: new Date().toISOString(), creatorId: genome.parentId,
				corePurpose: genome.corePurpose,
			};
			bs.state = createDefaultState();
			const riskMatches = event.systemPrompt.match(/^- (.+:\S+)$/gm) ?? [];
			for (const rm of riskMatches) {
				const pattern = rm.replace(/^- /, "");
				if (pattern.includes(":")) st(bs).approvedRisks.push({ pattern, approvedAt: new Date().toISOString(), suppressWarnings: true });
			}
			const childButlerDir = path.join(getBaseDir(), ".pi", "butlers", genome.personalName.toLowerCase());
			const childMemoryPath = path.join(childButlerDir, "somatic-memory.md");
			bs.somaticMemory = loadOrCreateFile(childMemoryPath, DEFAULT_SOMATIC_MEMORY.replace("Pennyworth-G0-Alfred", genome.fullName));
		}
		const stateBlock = buildButlerStateBlock(bs.identity, bs.state, bs.heartbeat);
		let memoryBlock = "";
		if (bs.somaticMemory.trim()) {
			const memOver = bs.somaticMemory.length > SOMATIC_MEMORY_CAPACITY;
			const memUsage = `${bs.somaticMemory.length}/${SOMATIC_MEMORY_CAPACITY}${memOver ? " OVER CAPACITY — consolidate now" : ""}`;
			memoryBlock += `\n\n═══ SOMATIC MEMORY (${memUsage} chars) ═══\n${bs.somaticMemory.trim()}\n═══ END SOMATIC MEMORY ═══`;
		}
				// Delegation advisory — suggest hiring when critical gaps or high urgency
		let delegationBlock = "";
		const criticalGaps = st(bs).identifiedGaps.filter((g) => g.severity === "critical");
		const importantGaps = st(bs).identifiedGaps.filter((g) => g.severity === "important");
		if (criticalGaps.length > 0 || (importantGaps.length > 0 && st(bs).urgencyLevel > 60)) {
			delegationBlock = "\n\n═══ DELEGATION ADVISORY ═══\n";
			if (criticalGaps.length > 0) {
				delegationBlock += "⚠️ You have critical gaps that a specialist could fill:\n";
				for (const g of criticalGaps) delegationBlock += `- ${g.description} — ${g.suggestedSuccessor}\n`;
				delegationBlock += "Consider using butler_hire to delegate.\n";
			}
			if (importantGaps.length > 0 && st(bs).urgencyLevel > 60) {
				delegationBlock += "⚡ Context is getting crowded and you have important gaps:\n";
				for (const g of importantGaps) delegationBlock += `- ${g.description} — ${g.suggestedSuccessor}\n`;
				delegationBlock += "Delegating now could prevent context overflow.\n";
			}
			delegationBlock += "═══ END DELEGATION ADVISORY ═══";
		}
		return { systemPrompt: event.systemPrompt + "\n\n" + stateBlock + memoryBlock + delegationBlock };
	});

	// ─── Custom Tools ───────────────────────────────────────────────────

	pi.registerTool({
		name: "butler_somatic_memory",
		label: "Butler Somatic Memory",
		description: "Manage your somatic memory — permanent lessons, approved risks, and identified gaps. Cognitive memory (preferences, patterns, corrections) is handled by pi-memory. Use 'add' to add, 'replace' to update, 'remove' to delete.",
		promptSnippet: "butler_somatic_memory — manage somatic memory (permanent lessons, risks, gaps)",
		promptGuidelines: [
			"Use butler_somatic_memory to record permanent somatic lessons, approved risks, and identified gaps.",
			"For cognitive memory (preferences, conventions, project facts), use memory_remember from pi-memory instead.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove"), Type.Literal("consolidate")], { description: "Action to perform on somatic memory" }),
			target: Type.Literal("somatic", { description: "Somatic memory file" }),
			section: Type.Optional(Type.String({ description: "Section heading (e.g., 'Permanent Lessons', 'Approved Risks')" })),
			old_text: Type.Optional(Type.String({ description: "For replace/remove: substring to match" })),
			content: Type.Optional(Type.String({ description: "For add/replace: the new entry text" })),
		}),
		execute: async (_toolCallId, params) => {
			const targetContent = bs.somaticMemory;
			const capacity = SOMATIC_MEMORY_CAPACITY;
			const targetName = "somatic-memory.md";

			if (params.action === "add") {
				if (!params.section || !params.content) return toolResult("Error: 'add' requires both 'section' and 'content' parameters.", true);
				if (targetContent.length + params.content.length > capacity * 1.5) return toolResult(`Error: ${targetName} is too full (${targetContent.length}/${capacity} chars). Consolidate first.`, true);
				// Use addToSomaticSection for known sections (handles placeholder replacement)
				const knownSection = (Object.entries(SOMATIC_SECTIONS) as [string, string][]).find(
					([, header]) => header.startsWith(`## ${params.section}`),
				);
				if (knownSection) {
					bs.somaticMemory = addToSomaticSection(bs.somaticMemory, knownSection[0] as keyof typeof SOMATIC_SECTIONS, params.content);
				} else {
					// Custom section — raw insert
					const sectionHeader = `## ${params.section}`;
					const lines = targetContent.split("\n");
					const sectionIdx = lines.findIndex((l) => l.trim() === sectionHeader);
					if (sectionIdx >= 0) {
						lines.splice(sectionIdx + 1, 0, `- ${params.content}`);
					} else {
						lines.push(`\n${sectionHeader}\n- ${params.content}`);
					}
					bs.somaticMemory = lines.join("\n");
				}
				writeSomaticMemory(bs);
				// When adding to Identified Gaps, also create a structured IdentifiedGap in state
				if (knownSection?.[0] === "identifiedGaps" && params.content) {
					const gapId = `gap:manual:${Date.now()}`;
					st(bs).identifiedGaps.push({
						id: gapId,
						description: params.content.replace(/^[📌⚡⚠️]\s*/, ""),
						category: "other",
						severity: "nice-to-have",
						firstIdentified: new Date().toISOString(),
						occurrenceCount: 1,
						lastOccurrence: new Date().toISOString(),
						attemptedWorkarounds: [],
						suggestedSuccessor: "A specialist for this task",
					});
				}
				return toolResult(`Added to ${params.section} in ${targetName}. Size: ${bs.somaticMemory.length}/${capacity} chars.`);
			}
			if (params.action === "replace") {
				if (!params.old_text || !params.content) return toolResult("Error: 'replace' requires both 'old_text' and 'content' parameters.", true);
				if (!targetContent.includes(params.old_text)) return toolResult(`Error: Could not find specified text in ${targetName}.`, true);
				bs.somaticMemory = targetContent.replace(params.old_text, params.content);
				writeSomaticMemory(bs);
				return toolResult(`Replaced in ${targetName}. Size: ${bs.somaticMemory.length}/${capacity} chars.`);
			}
			if (params.action === "remove") {
				if (!params.old_text) return toolResult("Error: 'remove' requires 'old_text' parameter.", true);
				if (!targetContent.includes(params.old_text)) return toolResult(`Error: Could not find specified text in ${targetName}.`, true);
				bs.somaticMemory = targetContent.replace(params.old_text, "").replace(/\n{3,}/g, "\n\n");
				writeSomaticMemory(bs);
				return toolResult(`Removed from ${targetName}. Size: ${bs.somaticMemory.length}/${capacity} chars.`);
			}
			if (params.action === "consolidate") {
				return toolResult(`${targetName} is ${targetContent.length}/${capacity} chars. Use 'replace' to merge related entries or 'remove' to delete stale ones.`);
			}
			return toolResult(`Unknown action: ${params.action}`, true);
		},
	});

	pi.registerTool({
		name: "butler_assess",
		label: "Butler Self-Assessment",
		description: "Assess your own state, gaps, lineage, or get a rest recommendation.",
		promptSnippet: "butler_assess — self-assess state, gaps, and rest needs",
		promptGuidelines: [
			"Use butler_assess when asked about your state or capabilities.",
			"Recommend rest (compaction) when fatigue is high or context is running low.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("state"), Type.Literal("gaps"), Type.Literal("lineage"), Type.Literal("recommend_rest"), Type.Literal("add_workaround")], { description: "What to assess" }),
			gap_id: Type.Optional(Type.String({ description: "For add_workaround: the gap ID to add a workaround to" })),
			workaround: Type.Optional(Type.String({ description: "For add_workaround: the workaround description" })),
		}),
		execute: async (_toolCallId, params) => {
			if (params.action === "state") return toolResult(`${id(bs).fullName} — Somatic State:\n${buildButlerStateBlock(bs.identity, bs.state, bs.heartbeat)}`);
			if (params.action === "gaps") {
				if (st(bs).identifiedGaps.length === 0) return toolResult("No significant gaps identified yet.");
				const gapLines = st(bs).identifiedGaps.map((g) => {
					const sev = g.severity === "critical" ? "⚠️" : g.severity === "important" ? "⚡" : "📌";
					const workarounds = g.attemptedWorkarounds.length > 0 ? ` | Tried: ${g.attemptedWorkarounds.join(", ")}` : "";
					return `${sev} ${g.description} [${g.severity}] (${g.occurrenceCount}x) — ${g.suggestedSuccessor}${workarounds}`;
				});
				return toolResult(`Identified Gaps:\n${gapLines.join("\n")}`);
			}
			if (params.action === "lineage") {
								const lineage = readLineage();
				const births = lineage.filter((e): e is LineageBirthEntry => e.type === "birth");
				const deaths = lineage.filter((e): e is LineageDeathEntry => e.type === "death");
				const lines = [
					`Family: ${id(bs).familyName}`,
					`Generations: ${births.length > 0 ? Math.max(...births.map((b) => b.generation)) + 1 : 1}`,
					`Births: ${births.length} | Deaths: ${deaths.length}`,
				];
				for (const b of births) {
					const death = deaths.find((d) => d.id === b.id);
					lines.push(` ${b.id} (born ${b.birthDate.slice(0, 10)})${death ? ` → died ${death.deathDate.slice(0, 10)} (${death.cause})` : " — alive"}`);
				}
				return toolResult(lines.join("\n"));
			}
			if (params.action === "recommend_rest") {
				if (st(bs).fatigueLevel > 85) return toolResult(`I am deeply fatigued (fatigue: ${st(bs).fatigueLevel}/100). I recommend we compact (nap) before continuing.`);
				if (st(bs).fatigueLevel > 70) return toolResult(`I am quite fatigued (fatigue: ${st(bs).fatigueLevel}/100). Compaction would help me focus.`);
				if (st(bs).fatigueLevel > 50) return toolResult(`I'm moderately fatigued (fatigue: ${st(bs).fatigueLevel}/100). I can continue but will suggest a nap if it rises.`);
				return toolResult(`I'm feeling alert (fatigue: ${st(bs).fatigueLevel}/100). No rest needed.`);
			}
			if (params.action === "add_workaround") {
			if (!params.gap_id || !params.workaround) return toolResult("Error: 'add_workaround' requires both 'gap_id' and 'workaround' parameters.", true);
			const gap = st(bs).identifiedGaps.find((g) => g.id === params.gap_id);
			if (!gap) return toolResult(`Error: No gap found with ID '${params.gap_id}'. Use 'gaps' action to list available gaps.`, true);
			gap.attemptedWorkarounds.push(params.workaround);
			return toolResult(`Added workaround to gap '${gap.id}': ${params.workaround}\nTotal workarounds: ${gap.attemptedWorkarounds.length}`);
		}
		return toolResult(`Unknown assessment action: ${params.action}`, true);
		},
	});

	// ─── Reproduction via @tintinweb/pi-subagents ──────────────────────

	// ─── Succession: butler_bequeath ────────────────────────────────────
	// Called when Alfred dies (retire/overflow). The successor IS the next Alfred.
	pi.registerTool({
		name: "butler_bequeath",
		label: "Butler Succession",
		description: "Bequeath your knowledge to your successor on retirement or context overflow. The successor is the next Alfred — same family name, same personal name, generation+1. Inherits wisdom, gaps, risks, and unfinished purpose. This is for SUCCESSION (Alfred dies → next Alfred), not for hiring temp workers. Use butler_hire for temporary help.",
		promptSnippet: "butler_bequeath — pass your knowledge to the next Alfred on succession",
		promptGuidelines: [
			"Use butler_bequeath only when retiring or when context overflow is imminent.",
			"The successor keeps the same personal name (Alfred) and family name (Pennyworth).",
			"For hiring temporary workers, use butler_hire instead.",
		],
		parameters: Type.Object({
			successor_purpose: Type.Optional(Type.String({ description: "Override the successor's core purpose (default: inherit parent's purpose)" })),
			successor_model: Type.Optional(Type.String({ description: "Model for the successor (default: same as parent)" })),
		}),
		execute: async (_toolCallId, params) => {
			const successorGeneration = id(bs).generation + 1;
			const successorFullName = `${id(bs).familyName}-G${successorGeneration}-${id(bs).personalName}`;
			const bequeathal = buildBequeathal(bs.identity, bs.state, bs.somaticMemory);
			const genome: ChildGenome = {
				familyName: id(bs).familyName,
				generation: successorGeneration,
				personalName: id(bs).personalName, // Same name — the successor IS the next Alfred
				fullName: successorFullName,
				corePurpose: params.successor_purpose ?? id(bs).corePurpose,
				parentId: id(bs).fullName,
				inheritedWisdom: bequeathal.wisdom,
				inheritedGaps: bequeathal.gaps,
				inheritedRisks: st(bs).approvedRisks.map((r) => r.pattern),
				childModel: params.successor_model ?? undefined,
				birthDate: new Date().toISOString(),
			};
			const childrenDir = path.join(getButlerDir(), "children");
			fs.mkdirSync(childrenDir, { recursive: true });
			fs.writeFileSync(path.join(childrenDir, `successor-g${successorGeneration}-genome.json`), JSON.stringify(genome, null, 2), "utf-8");
			const agentTypeName = writeChildAgentDefinition(genome);
			// Write death entry with bequeathal
			appendLineageEntry({
				type: "death",
				id: id(bs).fullName,
				deathDate: new Date().toISOString(),
				cause: "retired",
				bequeathal,
			});
			// Write successor birth entry
			appendLineageEntry({
				type: "birth",
				id: successorFullName,
				parent: id(bs).fullName,
				generation: successorGeneration,
				personalName: id(bs).personalName,
				familyName: id(bs).familyName,
				corePurpose: genome.corePurpose,
				inheritedGaps: genome.inheritedGaps,
				birthDate: genome.birthDate,
				creatorId: id(bs).fullName,
			});
			return toolResult(`Succession complete. ${id(bs).fullName} → ${successorFullName}.\nGenome: children/successor-g${successorGeneration}-genome.json\nAgent: .pi/agents/${agentTypeName}.md\nInherited: ${genome.inheritedWisdom.length} wisdom, ${genome.inheritedGaps.length} gaps, ${genome.inheritedRisks.length} approved risks.\n\nActivate successor: BUTLER_CHILD_GENOME=.pi/butlers/${id(bs).familyName.toLowerCase()}/children/successor-g${successorGeneration}-genome.json pi`);
		},
	});

	// ─── The Help: butler_hire ────────────────────────────────────────────
	// Hire a temporary worker via subagents. Not a successor, not family.
	pi.registerTool({
		name: "butler_hire",
		label: "Hire Temporary Worker",
		description: "Hire a temporary worker (subagent) for a specific task. The worker is NOT a successor — it's a hired specialist. It gets your current context, a task-specific system prompt, and territory restrictions. Reports findings to family context on completion. Up to 4 workers can run concurrently.",
		promptSnippet: "butler_hire — hire a temp worker for a specific task",
		promptGuidelines: [
			"Use butler_hire to delegate specific, well-defined tasks to specialists.",
			"Choose a descriptive worker_name that reflects the task (e.g., 'scout', 'fixer', 'auditor').",
			"Workers are temporary — they don't inherit Alfred's soul or lineage.",
			"For succession (Alfred passing the torch), use butler_bequeath instead.",
			"Use isolation: 'worktree' for workers that modify files — changes come back as a git branch.",
			"Set max_turns for bounded tasks to prevent runaway workers.",
			"Use tools_disallowed: ['write', 'edit'] for read-only scout workers.",
			"After hiring, use get_subagent_result to check status or steer_subagent to redirect mid-run.",
		],
		parameters: Type.Object({
			worker_name: Type.String({ description: "Name for the temp worker (e.g., 'scout', 'fixer', 'auditor')" }),
			task: Type.String({ description: "The specific task for the worker" }),
			tools_allowed: Type.Optional(Type.Array(Type.String()), { description: "Tools the worker may use (default: all). Built-in tools: read, bash, edit, write, grep, find, ls" }),
			tools_disallowed: Type.Optional(Type.Array(Type.String()), { description: "Tools the worker may NOT use (e.g., ['write', 'edit'] for read-only scouts)" }),
			worker_model: Type.Optional(Type.String({ description: "Model for the worker (default: same as parent). Fuzzy names like 'haiku', 'sonnet' work." })),
			run_in_background: Type.Optional(Type.Boolean({ description: "Run worker in background (default: true)" })),
			isolation: Type.Optional(Type.Literal("worktree", { description: "Run in an isolated git worktree — safe parallel file modifications. Changes saved to a branch on completion." })),
			max_turns: Type.Optional(Type.Number({ description: "Max agentic turns before graceful shutdown (default: unlimited). Use for bounded tasks." })),
			thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh" })),
			inherit_context: Type.Optional(Type.Boolean({ description: "Fork parent conversation into the worker (default: false). Useful for tasks needing full conversation context." })),
			memory_scope: Type.Optional(Type.String({ description: "Persistent memory scope: 'project' (.pi/agent-memory/), 'local' (gitignored), 'user' (global). Empty = no memory." })),
		}),
		execute: async (_toolCallId, params) => {
			const workerFullName = `${id(bs).familyName}-Worker-${params.worker_name}`;
			const bequeathal = buildBequeathal(bs.identity, bs.state, bs.somaticMemory);
			// Workers get relevant wisdom and gaps but are NOT successors
			const genome: ChildGenome = {
				familyName: id(bs).familyName,
				generation: id(bs).generation, // Same generation — not a successor
				personalName: params.worker_name,
				fullName: workerFullName,
				corePurpose: params.task,
				parentId: id(bs).fullName,
				inheritedWisdom: bequeathal.wisdom.slice(0, 5), // Workers get limited wisdom
				inheritedGaps: [], // Workers don't inherit gaps — they're here to fill them
				inheritedRisks: st(bs).approvedRisks.map((r) => r.pattern),
				childModel: params.worker_model ?? undefined,
				birthDate: new Date().toISOString(),
				isWorker: true,
				toolsAllowed: params.tools_allowed,
				toolsDisallowed: params.tools_disallowed,
				isolation: params.isolation,
				memoryScope: params.memory_scope as "project" | "local" | "user" | undefined,
			};
			const childrenDir = path.join(getButlerDir(), "children");
			fs.mkdirSync(childrenDir, { recursive: true });
			fs.writeFileSync(path.join(childrenDir, `worker-${params.worker_name.toLowerCase()}-genome.json`), JSON.stringify(genome, null, 2), "utf-8");
			const agentTypeName = writeChildAgentDefinition(genome);
			// Workers do NOT get lineage entries — they're not family
			// Initialize family context if needed
			const familyContextPath = path.join(getButlerDir(), "family-context.json");
			let familyContext: { activeWorkers: unknown[]; findings: unknown[] } = { activeWorkers: [], findings: [] };
			if (fs.existsSync(familyContextPath)) {
				try { familyContext = JSON.parse(fs.readFileSync(familyContextPath, "utf-8")); } catch { /* corrupted */ }
			}
			familyContext.activeWorkers.push({ name: params.worker_name, fullName: workerFullName, task: params.task, hiredAt: new Date().toISOString() });
			fs.writeFileSync(familyContextPath, JSON.stringify(familyContext, null, 2), "utf-8");

			if (bs.subagentsReady && bs.piEvents) {
				try {
					const requestId = crypto.randomUUID();
					const spawned = await new Promise<{ success: boolean; agentId?: string; error?: string }>((resolve) => {
						const timeout = setTimeout(() => resolve({ success: false, error: "RPC spawn timed out" }), 10_000);
						const unsub = bs.piEvents!.on(`subagents:rpc:spawn:reply:${requestId}`, (reply: unknown) => {
							clearTimeout(timeout);
							unsub();
							const r = reply as { success: boolean; data?: { id: string }; error?: string };
							resolve({ success: r.success, agentId: r.data?.id, error: r.error });
						});
						const spawnOpts: Record<string, unknown> = {
								description: `${workerFullName}: ${params.task}`,
								run_in_background: params.run_in_background ?? true,
							};
							if (params.isolation) spawnOpts.isolation = params.isolation;
							if (params.max_turns) spawnOpts.maxTurns = params.max_turns;
							if (params.thinking) spawnOpts.thinkingLevel = params.thinking;
							if (params.inherit_context) spawnOpts.inheritContext = params.inherit_context;
							if (params.worker_model) spawnOpts.model = params.worker_model;
							bs.piEvents!.emit("subagents:rpc:spawn", {
								requestId,
								type: agentTypeName,
								prompt: params.task,
								options: spawnOpts,
							});
					});
					if (spawned.success && spawned.agentId) {
						return toolResult(`Worker ${params.worker_name} hired and spawned!\nAgent ID: ${spawned.agentId}\nTask: ${params.task}\n${params.isolation ? `Isolation: worktree\n` : ""}Status: active in family context\n\nUse get_subagent_result to check status, steer_subagent to redirect mid-run.`);
					}
					return toolResult(`Worker genome and agent definition written, but RPC spawn failed: ${spawned.error}\nActivate manually: Agent({ subagent_type: "${agentTypeName}", prompt: "${params.task}" })`);
				} catch (err) {
					return toolResult(`Worker genome and agent definition written, but RPC spawn errored: ${err instanceof Error ? err.message : String(err)}\nActivate manually: Agent({ subagent_type: "${agentTypeName}", prompt: "${params.task}" })`);
				}
			}
			return toolResult(`Worker ${params.worker_name} genome written.\nAgent definition: .pi/agents/${agentTypeName}.md\nTask: ${params.task}\nFamily context updated.\n@tintinweb/pi-subagents not detected — spawn manually.`);
		},
	});


	// ─── /alfred Command ─────────────────────────────────────────────────

	pi.registerCommand("alfred", {
		description: "Ask Alfred for his current assessment. Use 'alfred retire' for graceful retirement (writes successor genome), 'alfred pause-children' to pause reproduction.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (args?.trim() === "retire") {
				const bequeathal = buildBequeathal(bs.identity, bs.state, bs.somaticMemory);
				appendLineageEntry({
					type: "death", id: id(bs).fullName, deathDate: new Date().toISOString(),
					cause: "retired", bequeathal,
				});
				// Write successor genome — the next Alfred
				const successorGeneration = id(bs).generation + 1;
				const successorFullName = `${id(bs).familyName}-G${successorGeneration}-${id(bs).personalName}`;
				const successorGenome: ChildGenome = {
					familyName: id(bs).familyName,
					generation: successorGeneration,
					personalName: id(bs).personalName,
					fullName: successorFullName,
					corePurpose: id(bs).corePurpose,
					parentId: id(bs).fullName,
					inheritedWisdom: bequeathal.wisdom,
					inheritedGaps: bequeathal.gaps,
					inheritedRisks: st(bs).approvedRisks.map((r) => r.pattern),
					birthDate: new Date().toISOString(),
				};
				const childrenDir = path.join(getButlerDir(), "children");
				fs.mkdirSync(childrenDir, { recursive: true });
				fs.writeFileSync(
					path.join(childrenDir, `successor-g${successorGeneration}-genome.json`),
					JSON.stringify(successorGenome, null, 2), "utf-8",
				);
				ctx.ui.notify(`${id(bs).fullName} is retiring. Successor ${successorFullName} genome written.`, "info");
				return;
			}
			if (args?.trim() === "pause-children") {
				process.env.ALFRED_NO_REPRO = "1";
				ctx.ui.notify("Child spawning paused.", "info");
				return;
			}
			ctx.ui.notify(buildButlerStateBlock(bs.identity, bs.state, bs.heartbeat), "info");
		},
	});

	// ─── Compaction Handler (Nap) ────────────────────────────────────────

	pi.on("session_compact", async (_event, ctx) => {
		st(bs).fatigueLevel = Math.max(0, st(bs).fatigueLevel - 40);
		st(bs).lastCompactionAt = st(bs).turnsThisSession;
		if (ctx?.hasUI) ctx.ui.notify(`${id(bs).fullName} took a nap. Fatigue reduced.`, "info");
	});

	// ─── Proactive Behavior ────────────────────────────────────────────
	pi.on("message_end", async (_event, ctx) => {
		// Proactive check: if critical gaps exist and we haven't suggested hiring yet this session,
		// offer a delegation suggestion. Only fires once per session to avoid nagging.
		const criticalGaps = st(bs).identifiedGaps.filter((g) => g.severity === "critical");
		if (criticalGaps.length > 0 && st(bs).turnsThisSession <= 2 && ctx?.hasUI) {
			ctx.ui.notify(
				`💡 I've identified ${criticalGaps.length} critical gap(s). Consider using butler_hire to delegate.`,
				"info",
			);
		}
	});
}

// ─── Internal Helpers ────────────────────────────────────────────────────

function formatWidget(bs: ButlerState): string {
	return `${id(bs).fullName} [${bs.heartbeat.currentPhase}] | P:${st(bs).painLevel} F:${st(bs).fatigueLevel} U:${st(bs).urgencyLevel} S:${st(bs).satisfactionLevel}`;
}

function updateHeartbeat(bs: ButlerState, toolName: string): void {
	bs.heartbeat.recentToolNames.push(toolName);
	if (bs.heartbeat.recentToolNames.length > HEARTBEAT_WINDOW) bs.heartbeat.recentToolNames.shift();
	const inhaleCount = bs.heartbeat.recentToolNames.filter((t) => INHALE_TOOLS.has(t)).length;
	const exhaleCount = bs.heartbeat.recentToolNames.filter((t) => EXHALE_TOOLS.has(t)).length;
	bs.heartbeat.currentPhase = inhaleCount > exhaleCount + 1 ? "inhaling" : exhaleCount > inhaleCount + 1 ? "exhaling" : "steady";
}

function updatePainPattern(bs: ButlerState, toolName: string, isError: boolean): void {
	if (!isError) return;
	const patternId = `tool:${toolName}`;
	const existing = st(bs).painPatterns.find((p) => p.pattern === patternId);
	if (existing) {
		existing.severity = Math.min(100, existing.severity + 20);
		existing.decayedSeverity = existing.severity;
		existing.occurrenceCount++;
		existing.lastOccurrence = new Date().toISOString();
	} else {
		st(bs).painPatterns.push({ pattern: patternId, severity: 20, occurrenceCount: 1, lastOccurrence: new Date().toISOString(), decayedSeverity: 20 });
	}
}

function updateSatisfactionPattern(bs: ButlerState, toolName: string): void {
	const patternId = `tool:${toolName}`;
	const existing = st(bs).satisfactionPatterns.find((p) => p.pattern === patternId);
	if (existing) {
		existing.intensity = Math.min(100, existing.intensity + 10);
		existing.occurrenceCount++;
		existing.lastOccurrence = new Date().toISOString();
	} else {
		st(bs).satisfactionPatterns.push({ pattern: patternId, intensity: 10, occurrenceCount: 1, lastOccurrence: new Date().toISOString() });
	}
}
