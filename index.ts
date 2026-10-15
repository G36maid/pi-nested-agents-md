/**
 * nested-agents-md — a pi coding agent extension.
 *
 * Clones OpenCode V2's "nested AGENTS.md" feature (github.com/anomalyco/opencode,
 * formerly sst/opencode): instruction files below the workspace are discovered as
 * the agent explores the project. Reading a file or listing a directory loads any
 * AGENTS.md files between that target and the workspace root.
 *
 * Source mapping (OpenCode V2, packages/core):
 *   - packages/core/src/tool/plugin/read.ts         post-read discovery hook
 *     -> here: pi.on("tool_result") for the "read" and "ls" tools
 *   - FSUtil.up({ targets: ["AGENTS.md"], stop: root })  nearest-first upward walk
 *     -> here: upWalk()
 *   - packages/core/src/session/instructions.ts     SessionInstructions.Service.load
 *     -> here: inject() with the same three guards:
 *        1. in-flight claim      (same-step parallel reads settle concurrently)
 *        2. durable ledger       (paths injected in a synthetic message still in
 *                                model-visible history are not re-injected)
 *        3. failure isolation    (discovery failures never fail the read)
 *   - SessionEvent.Synthetic text `Instructions from: <path>\n<content>`
 *     -> here: pi.sendMessage(..., { triggerTurn: false }), which pi flushes at
 *        turn_end — after tool results are in history, before the next model
 *        request of the same run. Custom messages become user-role text for the
 *        model, exactly like OpenCode synthetics.
 *
 * Behavior parity with the OpenCode feature (per opencode.ai/v2/docs/instructions):
 *   - Nested files load nearest-first and are deduplicated while their instruction
 *     entry remains in model-visible history. If compaction or a revert removes the
 *     entry, a later read loads the file again (the ledger is derived from the
 *     compaction-aware context, so this falls out automatically — and reverting the
 *     branch also restores the older ledger state, like OpenCode's session-move rule).
 *   - Reading an AGENTS.md file itself does not inject it again (it is already
 *     visible as the read result).
 *   - Edits to a nested file are NOT detected automatically after it loads. Start a
 *     new session when updated text must apply.
 *   - The workspace file, its ancestors, and the agent-directory file are ambient
 *     instructions. Pi core already loads those at startup (context-file discovery
 *     covers the agent directory, the working directory, and its parent
 *     directories), so this extension walks strictly below that boundary and
 *     excludes ancestor-chain files it would meet on external reads — the same
 *     filter OpenCode applies ("the Location and its ancestors are already supplied
 *     by initial instructions").
 *   - External reads are skipped. OpenCode gates discovery to the workspace
 *     (FileAccess marks targets outside the workspace dir/project root as
 *     external; the read tool returns before discovering for those). pi's read
 *     tool has no internal/external split, so the gate is a containment check
 *     on the resolved target — otherwise reading a SKILL.md from your dotfiles
 *     would walk up and load your dotfiles' AGENTS.md.
 *   - Unreadable candidate files are skipped silently; a failed discovery never
 *     fails the triggering read.
 *
 * pi-flavored superset (documented deviation): within one directory,
 * AGENTS.override.md wins over AGENTS.md, mirroring pi's own context-file rule.
 */

import { promises as fsp } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

/** customType for the injected instruction messages (also the dedup ledger key). */
const CUSTOM_TYPE = "nested-agents-md";

/** Candidate filenames, checked in order; first existing file wins per directory. */
const FILENAMES = ["AGENTS.override.md", "AGENTS.md"] as const;

/** Shape of the message `details`; the ledger reads paths back out of history. */
interface InstructionDetails {
	paths: string[];
}

/** Resolved AGENTS.md file ready for injection. */
interface LoadedFile {
	path: string;
	content: string;
}

export default function nestedAgentsMd(pi: ExtensionAPI) {
	/**
	 * OpenCode resolves the Location once per instance; we refresh the workspace
	 * root on session start. Absolute, symlink-resolved, existence guaranteed by
	 * the running process — falls back to the raw cwd when realpath fails.
	 */
	let workspaceRoot = "";

	/**
	 * In-flight claim, mirroring SessionInstructions' `inFlight` Ref: "Same-step
	 * parallel reads settle concurrently, so an in-memory claim guards each
	 * Session/path pair while a load is in flight." Claims are released at
	 * turn_end — pi flushes queued custom messages there, after which the durable
	 * ledger in history takes over as the only lasting record.
	 */
	let inFlight = new Set<string>();

	// -- helpers -------------------------------------------------------------

	const realpathSafe = async (path: string): Promise<string> => {
		try {
			return await fsp.realpath(path);
		} catch {
			return path;
		}
	};

	/** Is `child` inside `parent` (or equal to it)? Lexical, on resolved paths. */
	const contains = (parent: string, child: string): boolean => {
		if (parent === child) return true;
		const rel = relative(parent, child);
		return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
	};

	/**
	 * Nearest-first upward walk. OpenCode stops at the workspace root, but for
	 * external reads the stop is unreachable and the walk continues to the
	 * filesystem root; the caller's filter then drops ancestor-chain files. We
	 * always walk to the filesystem root and let the filter decide — same result,
	 * one code path.
	 */
	const upWalk = async (startDir: string): Promise<string[]> => {
		const found: string[] = [];
		let dir = startDir;
		for (;;) {
			for (const name of FILENAMES) {
				const candidate = join(dir, name);
				try {
					const stat = await fsp.stat(candidate);
					if (stat.isFile()) {
						found.push(candidate);
						break; // one instruction file per directory; override wins
					}
				} catch {
					// absent or unreadable: try the next filename
				}
			}
			const parent = dirname(dir);
			if (parent === dir) break; // filesystem root
			dir = parent;
		}
		return found;
	};

	/**
	 * The durable ledger. OpenCode scans synthetic-message metadata in the
	 * session store ("the synthetic message metadata scanned below is the only
	 * lasting ledger"). We scan our custom messages in the compaction-aware
	 * context: entries a compaction summarized away drop out, which re-admits
	 * their paths for the next discovery, exactly as documented.
	 */
	const previouslyInjected = (ctx: ExtensionContext): Set<string> => {
		const injected = new Set<string>();
		for (const entry of ctx.sessionManager.buildContextEntries()) {
			if (entry.type !== "custom_message" || entry.customType !== CUSTOM_TYPE) continue;
			const details = entry.details as InstructionDetails | undefined;
			for (const path of details?.paths ?? []) injected.add(path);
		}
		return injected;
	};

	/** Human-facing path, relative to the workspace root when underneath it. */
	const describePath = (path: string): string => {
		if (workspaceRoot && contains(workspaceRoot, path)) return relative(workspaceRoot, path);
		return path;
	};

	/**
	 * OpenCode's SessionInstructions.load: claim -> dedupe against the ledger ->
	 * read (skipping unreadable files) -> publish one synthetic carrying all
	 * files, `Instructions from: <path>\n<content>`, nearest-first, joined by a
	 * blank line.
	 */
	const inject = async (ctx: ExtensionContext, absolutePaths: string[]): Promise<void> => {
		const claimed = absolutePaths.filter((path) => !inFlight.has(path));
		if (claimed.length === 0) return;
		for (const path of claimed) inFlight.add(path);
		try {
			const alreadyInjected = previouslyInjected(ctx);
			const toInject = claimed.filter((path) => !alreadyInjected.has(path));
			if (toInject.length === 0) return;

			const files: LoadedFile[] = [];
			for (const path of toInject) {
				try {
					const content = await fsp.readFile(path, "utf8");
					if (content.trim().length === 0) continue; // nothing to instruct with
					files.push({ path, content });
				} catch {
					// "A temporary read failure preserves the last known instructions":
					// the path is simply not admitted this round; a later read retries.
				}
			}
			if (files.length === 0) return;

			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n"),
					display: true,
					details: { paths: files.map((file) => file.path) satisfies InstructionDetails["paths"] } satisfies InstructionDetails,
				},
				// Context-only delivery: while a run is streaming, pi queues the
				// message and flushes it at turn_end — after the tool results are in
				// history, before the next model request of the same run. Idle: it is
				// appended directly. Either way no turn is triggered by instructions.
				{ triggerTurn: false },
			);
		} finally {
			// Claims last only until the batch settles; from the next turn the
			// history ledger is authoritative.
			for (const path of claimed) inFlight.delete(path);
		}
	};

	/**
	 * OpenCode's post-read discovery block: resolve the target, walk up, filter,
	 * load. Discovery failures never fail the read — one catch at the boundary.
	 */
	const discover = async (ctx: ExtensionContext, rawPath: string, startAtSelf: boolean): Promise<void> => {
		const resolvedTarget = await realpathSafe(resolve(ctx.cwd, rawPath));
		// "External reads are skipped" (read.ts: `if (result.target.externalDirectory
		// !== undefined) return`). OpenCode flags anything outside the workspace dir
		// or project root as external in FileAccess.resolve; pi's read tool has no
		// internal/external split, so the gate is reproduced with a containment
		// check on the resolved target. Without it, reading a file from an
		// unrelated tree — a SKILL.md from your dotfiles, for example — would walk
		// up from there and inject that tree's AGENTS.md into the session. The
		// realpath (not the given path) decides, so symlinks pointing outside the
		// workspace are external too.
		if (workspaceRoot === "" || !contains(workspaceRoot, resolvedTarget)) return;
		const startDir = startAtSelf ? resolvedTarget : dirname(resolvedTarget);
		const discovered = await upWalk(startDir);
		const candidates = discovered.filter(
			(file) =>
				!(workspaceRoot && contains(dirname(file), workspaceRoot)) && // ancestors of the root are ambient
				file !== resolvedTarget, // reading an AGENTS.md never injects itself
		);
		// Dedupe within one batch (sibling tools can discover overlapping chains).
		if (candidates.length === 0) return;
		await inject(ctx, [...new Set(candidates)]);
	};

	// -- lifecycle -----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		inFlight = new Set();
		workspaceRoot = await realpathSafe(ctx.cwd);
	});

	// Claims are moot once the turn's messages are flushed into history.
	pi.on("turn_end", async () => {
		inFlight.clear();
	});

	// The discovery hook. OpenCode triggers on its one `read` tool (files and
	// directory listings); pi splits that into `read` and `ls`, so both trigger:
	// a file read starts at its dirname, a directory listing at the directory
	// itself ("so its own AGENTS.md is discovered").
	pi.on("tool_result", async (event, ctx) => {
		try {
			if (event.isError) return; // only successful reads/listings discover
			if (workspaceRoot === "") return; // session not initialized yet
			if (event.toolName === "read") {
				const path = (event.input as { path?: unknown }).path;
				if (typeof path === "string" && path.length > 0) await discover(ctx, path, false);
			} else if (event.toolName === "ls") {
				const path = (event.input as { path?: unknown }).path;
				await discover(ctx, typeof path === "string" && path.length > 0 ? path : ".", true);
			}
		} catch {
			// Discovery failures never fail the triggering tool result.
		}
	});

	// -- transcript rendering ------------------------------------------------

	// OpenCode's synthetic shows "Loaded <paths>" as its description; we render
	// the same compact line, with the full instruction text one keystroke away.
	pi.registerMessageRenderer<InstructionDetails>(CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
		const names = (message.details?.paths ?? []).map(describePath).join(", ");
		const box = new Box(outputPad, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("muted", "Loaded")} ${theme.fg("accent", names || "instructions")}`, 0, 0));
		if (expanded && typeof message.content === "string") {
			box.addChild(new Text(message.content, 0, 1));
		}
		return box;
	});

	// -- command -------------------------------------------------------------

	pi.registerCommand("agents-md", {
		description: "List nested AGENTS.md instruction files loaded in this session",
		handler: async (_args, ctx) => {
			const paths = [...previouslyInjected(ctx)].sort();
			const lines =
				paths.length === 0
					? "No nested instruction files loaded yet. Read or list files in a subdirectory that has an AGENTS.md."
					: paths.map((path) => `  ${describePath(path)}`).join("\n");
			if (ctx.hasUI) {
				ctx.ui.notify(`Nested AGENTS.md files:\n${lines}`, "info");
			}
		},
	});
}
