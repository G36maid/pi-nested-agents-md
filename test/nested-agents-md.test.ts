/**
 * Regression tests for the duplicate-load bug: two reads from the same module
 * within one turn used to inject the same AGENTS.md twice, because the
 * in-flight claim was released as soon as the synthetic message was *queued*,
 * while pi only flushes queued custom messages into session history (the
 * durable ledger) at turn_end.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import nestedAgentsMd from "../index.js";

// -- fakes -----------------------------------------------------------------

interface CustomMessageRecord {
	customType: string;
	content: string;
	display: boolean;
	details?: { paths: string[] };
}

interface SessionEntryLike {
	type: string;
	customType?: string;
	details?: { paths: string[] };
}

function makeHarness() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
	const sent: CustomMessageRecord[] = [];
	/** Simulates pi's pending queue: entries only become visible in history at turn_end. */
	let history: SessionEntryLike[] = [];

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
			return () => {};
		},
		sendMessage(message: CustomMessageRecord) {
			sent.push(message); // queued, NOT in history yet (triggerTurn: false while streaming)
		},
		registerMessageRenderer() {
			return () => {};
		},
		registerCommand() {
			return () => {};
		},
	} as unknown as Parameters<typeof nestedAgentsMd>[0] & {
		sendMessage: (m: CustomMessageRecord) => void;
	};

	const dir = mkdtempSync(join(tmpdir(), "nested-agents-md-"));
	mkdirSync(join(dir, "packages/api/src"), { recursive: true });
	writeFileSync(join(dir, "AGENTS.md"), "# root\n");
	writeFileSync(join(dir, "packages/api/AGENTS.md"), "# api\n");
	writeFileSync(join(dir, "packages/api/src/a.ts"), "export const a = 1;\n");
	writeFileSync(join(dir, "packages/api/src/b.ts"), "export const b = 2;\n");

	const ctx = {
		cwd: dir,
		sessionManager: {
			buildContextEntries: () => history,
		},
	};

	const emit = async (event: string, payload: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};

	const toolResult = (path: string) => emit("tool_result", { toolName: "read", input: { path }, isError: false });

	const turnEnd = () => {
		// pi flushes queued custom messages into session history at turn_end.
		history = sent.map((m) => ({ type: "custom_message", customType: m.customType, details: m.details }));
		return emit("turn_end");
	};

	nestedAgentsMd(pi as never);
	return { pi, sent, emit, toolResult, turnEnd, dir };
}

afterAll(() => {
	// temp dirs are small; OS cleans tmpdir
});

describe("nested-agents-md duplicate-load regression", () => {
	it("injects the module AGENTS.md once when two same-module files are read in one turn (sequential dispatch)", async () => {
		const h = makeHarness();
		await h.emit("session_start");

		await h.toolResult("packages/api/src/a.ts");
		await h.toolResult("packages/api/src/b.ts");

		const apiLoads = h.sent.filter((m) => m.details?.paths.some((p) => p.endsWith("packages/api/AGENTS.md")));
		expect(apiLoads).toHaveLength(1);
	}, 20000);

	it("injects once when the two reads settle concurrently (interleaved discovery)", async () => {
		const h = makeHarness();
		await h.emit("session_start");

		// Interleave: both handlers run their discovery chain before either injects.
		const r1 = h.toolResult("packages/api/src/a.ts");
		const r2 = h.toolResult("packages/api/src/b.ts");
		await Promise.all([r1, r2]);

		const apiLoads = h.sent.filter((m) => m.details?.paths.some((p) => p.endsWith("packages/api/AGENTS.md")));
		expect(apiLoads).toHaveLength(1);
	}, 20000);

	it("does not re-inject after turn_end once the ledger is in history", async () => {
		const h = makeHarness();
		await h.emit("session_start");

		await h.toolResult("packages/api/src/a.ts");
		await h.turnEnd();
		const afterFirstTurn = h.sent.length;

		await h.toolResult("packages/api/src/b.ts");
		await h.turnEnd();

		expect(h.sent).toHaveLength(afterFirstTurn);
	}, 20000);

	it("still loads a different module's AGENTS.md on first read", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		mkdirSync(join(h.dir, "packages/web/src"), { recursive: true });
		writeFileSync(join(h.dir, "packages/web/AGENTS.md"), "# web\n");

		await h.toolResult("packages/web/src/index.ts");

		const paths = h.sent.flatMap((m) => m.details?.paths ?? []);
		expect(paths.some((p) => p.endsWith("packages/web/AGENTS.md"))).toBe(true);
	}, 20000);
});
