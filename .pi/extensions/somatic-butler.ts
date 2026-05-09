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
			const result = data as { id?: string; agentType?: string; success?: boolean };
			if (result.agentType?.startsWith("butler-")) {
				// TODO: write findings to family context instead of death entry
				const deathEntry: LineageDeathEntry = {
					type: "death",
					id: result.id ?? result.agentType,
					deathDate: new Date().toISOString(),
					cause: "context-overflow",
					bequeathal: { wisdom: [], gaps: [], approvedRisks: [], failedApproaches: [], unfinishedPurpose: "Child session completed" },
				};
				appendLineageEntry(deathEntry);
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
			bs.identity = loadOrCreateIdentity();
			bs.state = loadOrCreateState();
			bs.somaticMemory = loadOrCreateFile(getSomaticMemoryPath(), DEFAULT_SOMATIC_MEMORY);
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
		try {
			(pi as unknown as { appendEntry: (type: string, data: unknown) => void }).appendEntry(STATE_ENTRY_TYPE, { ...bs.state });
		} catch { /* appendEntry may not be available */ }
		if (st(bs).urgencyLevel >= 90 && !st(bs)._overflowDeathWritten) {
			appendLineageEntry({
				type: "death", id: id(bs).fullName, deathDate: new Date().toISOString(),
				cause: "context-overflow", bequeathal: buildBequeathal(bs.identity, bs.state, bs.somaticMemory),
			});
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
		return { systemPrompt: event.systemPrompt + "\n\n" + stateBlock + memoryBlock };
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
			action: Type.Union([Type.Literal("state"), Type.Literal("gaps"), Type.Literal("lineage"), Type.Literal("recommend_rest")], { description: "What to assess" }),
		}),
		execute: async (_toolCallId, params) => {
			if (params.action === "state") return toolResult(`${id(bs).fullName} — Somatic State:\n${buildButlerStateBlock(bs.identity, bs.state, bs.heartbeat)}`);
			if (params.action === "gaps") {
				const gaps = st(bs).painPatterns.filter((p) => p.occurrenceCount >= 3).map((p) => `- ${p.pattern} (${p.occurrenceCount} failures, severity ${p.decayedSeverity})`);
				return gaps.length === 0 ? toolResult("No significant gaps identified yet.") : toolResult(`Identified Gaps:\n${gaps.join("\n")}`);
			}
			if (params.action === "lineage") {
				const { readLineage } = await import("./somatic-butler/utils.js");
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
			return toolResult(`Unknown assessment action: ${params.action}`, true);
		},
	});

	// ─── Reproduction via @tintinweb/pi-subagents ──────────────────────

	pi.registerTool({
		name: "butler_spawn",
		label: "Butler Reproduction",
		description: "Spawn a child butler to fill an identified gap. The child inherits your wisdom, gaps, and approved risks.",
		promptSnippet: "butler_spawn — spawn a child butler to fill a capability gap",
		promptGuidelines: [
			"Only spawn a child when you've identified a genuine gap you cannot fill.",
			"Design the child's purpose to specifically address the gap.",
		],
		parameters: Type.Object({
			child_name: Type.String({ description: "Name for the child butler (e.g., 'Scout', 'Forge')" }),
			child_purpose: Type.String({ description: "The child's core purpose — what gap it fills" }),
			child_model: Type.Optional(Type.String({ description: "Model for the child (default: same as parent)" })),
			run_in_background: Type.Optional(Type.Boolean({ description: "Run child in background (default: true)" })),
		}),
		execute: async (_toolCallId, params) => {
			if (process.env.ALFRED_NO_REPRO === "1") return toolResult("Child spawning is currently paused.", true);
			const childGeneration = id(bs).generation + 1;
			const childFullName = `${id(bs).familyName}-G${childGeneration}-${params.child_name}`;
			const bequeathal = buildBequeathal(bs.identity, bs.state, bs.somaticMemory);
			const genome: ChildGenome = {
				familyName: id(bs).familyName, generation: childGeneration,
				personalName: params.child_name, fullName: childFullName,
				corePurpose: params.child_purpose, parentId: id(bs).fullName,
				inheritedWisdom: bequeathal.wisdom, inheritedGaps: bequeathal.gaps,
				inheritedRisks: st(bs).approvedRisks.map((r) => r.pattern),
				childModel: params.child_model ?? undefined, birthDate: new Date().toISOString(),
			};
			const childrenDir = path.join(getButlerDir(), "children");
			fs.mkdirSync(childrenDir, { recursive: true });
			fs.writeFileSync(path.join(childrenDir, `${params.child_name.toLowerCase()}-genome.json`), JSON.stringify(genome, null, 2), "utf-8");
			const agentTypeName = writeChildAgentDefinition(genome);
			appendLineageEntry({
				type: "birth", id: childFullName, parent: id(bs).fullName,
				generation: childGeneration, personalName: params.child_name,
				familyName: id(bs).familyName, corePurpose: params.child_purpose,
				inheritedGaps: genome.inheritedGaps, birthDate: genome.birthDate,
				creatorId: id(bs).fullName,
			});
			if (bs.subagentsReady && bs.piEvents) {
				try {
					const requestId = crypto.randomUUID();
					const spawned = await new Promise<{ success: boolean; agentId?: string; error?: string }>((resolve) => {
						const timeout = setTimeout(() => resolve({ success: false, error: "RPC spawn timed out" }), 10_000);
						const unsub = bs.piEvents!.on(`subagents:rpc:spawn:reply:${requestId}`, (reply: unknown) => {
							clearTimeout(timeout); unsub();
							const r = reply as { success: boolean; data?: { id: string }; error?: string };
							resolve({ success: r.success, agentId: r.data?.id, error: r.error });
						});
						bs.piEvents!.emit("subagents:rpc:spawn", {
							requestId, type: agentTypeName, prompt: params.child_purpose,
							options: { description: `${childFullName}: ${params.child_purpose}`, run_in_background: params.run_in_background ?? true },
						});
					});
					if (spawned.success && spawned.agentId) {
						return toolResult(`Child butler ${childFullName} spawned successfully!\nAgent ID: ${spawned.agentId}\nPurpose: ${params.child_purpose}\nInherited: ${genome.inheritedWisdom.length} wisdom, ${genome.inheritedGaps.length} gaps, ${genome.inheritedRisks.length} approved risks.`);
					}
					return toolResult(`Child genome and agent definition written, but RPC spawn failed: ${spawned.error}\nActivate manually: Agent({ subagent_type: "${agentTypeName}", prompt: "${params.child_purpose}" })`);
				} catch (err) {
					return toolResult(`Child genome and agent definition written, but RPC spawn errored: ${err instanceof Error ? err.message : String(err)}\nActivate manually: Agent({ subagent_type: "${agentTypeName}", prompt: "${params.child_purpose}" })`);
				}
			}
			return toolResult(`Child butler ${childFullName} genome written.\nAgent definition: .pi/agents/${agentTypeName}.md\nPurpose: ${params.child_purpose}\n@tintinweb/pi-subagents not detected — spawn manually.`);
		},
	});

	// ─── /alfred Command ─────────────────────────────────────────────────

	pi.registerCommand("alfred", {
		description: "Ask Alfred for his current assessment. Use 'alfred retire' for graceful retirement, 'alfred pause-children' to pause reproduction.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (args?.trim() === "retire") {
				appendLineageEntry({
					type: "death", id: id(bs).fullName, deathDate: new Date().toISOString(),
					cause: "retired", bequeathal: buildBequeathal(bs.identity, bs.state, bs.somaticMemory),
				});
				ctx.ui.notify(`${id(bs).fullName} is retiring. Bequeathal written.`, "info");
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
