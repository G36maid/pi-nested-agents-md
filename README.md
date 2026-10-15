# pi-nested-agents-md

A [pi coding agent](https://github.com/earendil-works/pi) extension that clones
OpenCode V2's **nested `AGENTS.md`** feature: instruction files below the
workspace are discovered as the agent explores the project. Reading a file or
listing a directory loads any `AGENTS.md` files between that target and the
workspace root, nearest-first, deduplicated, and injects them into the running
session as context.

Upstream: [`anomalyco/opencode`](https://github.com/anomalyco/opencode) (moved
from `sst/opencode` after SST rebranded to Anomaly). The implementation was
written against the V2 `dev` sources:

- `packages/core/src/tool/plugin/read.ts` — post-read discovery hook
- `packages/core/src/session/instructions.ts` — `SessionInstructions.load`
  (in-flight claim, durable ledger, synthetic publish)

## Install

Copy or symlink into your extensions directory:

```bash
git clone <this repo> ~/.pi/agent/extensions/nested-agents-md
```

or load directly during development:

```bash
pi --extension ./index.ts
```

No dependencies beyond pi itself (type imports plus `@earendil-works/pi-tui`
for transcript rendering).

## What it does

1. **Discovery trigger** — after every successful `read` (file) or `ls`
   (directory) tool result, walk upward from the target (the file's directory,
   or the listed directory itself) toward the filesystem root.
2. **Filter** — keep candidate instruction files strictly below the workspace
   root. Files on the ancestor chain of the workspace root are excluded: pi
   core already loads the working directory, its parents, and the agent
   directory at startup, exactly as OpenCode treats its Location and its
   ancestors as "already supplied by initial instructions".
3. **Inject** — unseen files are published as one custom message per batch:

   ```
   Instructions from: /repo/packages/api/AGENTS.md
   <content>

   Instructions from: /repo/packages/api/src/AGENTS.md
   <content>
   ```

   pi converts custom messages to user-role text for the model and, when sent
   with `triggerTurn: false` during a run, flushes them after the tool results
   are in history and **before the next model request of the same run** — the
   same timing as OpenCode's synthetic injection.

4. **Dedup** — paths stay deduplicated while their instruction entry remains
   in model-visible history. If compaction or a session revert removes the
   entry, a later read discovers the file again. Reverting a branch also
   restores the older ledger state, matching OpenCode's session-revert rule.
5. **Never fails the read** — discovery errors, unreadable files, and empty
   files are swallowed silently.
6. **No watching** — like OpenCode, edits to a loaded nested file are *not*
   detected automatically; start a new session to pick up changes.

The transcript shows a compact `Loaded packages/api/AGENTS.md, …` line
(collapsed) with the full instruction text on expand.

### pi-flavored deviations

- `AGENTS.override.md` wins over `AGENTS.md` **within the same directory**,
  mirroring pi's own context-file rule. OpenCode only knows `AGENTS.md`.
- `/agents-md` lists every nested instruction file currently loaded in the
  session.

## Try it

```bash
cd test/fixture-monorepo
pi --extension ../index.ts
```

Then ask the agent to read `packages/api/src/index.ts`. The transcript should
show `Loaded packages/api/AGENTS.md, packages/api/src/AGENTS.md` and the model
should acknowledge both rule sets. Reading something under `packages/web/`
loads only the web rules.

Regression test for external reads — reading a skill from an unrelated tree
must NOT load that tree's `AGENTS.md`:

```bash
pi --extension ./index.ts -p "Read $(pwd)/test/fixture-dotfiles/skills/neo/SKILL.md, then answer: does any 'Instructions from:' message exist in your context? yes/no"
```

Expected: `no` — the dotfiles `AGENTS.md` stays out of the session.

## Behavior matrix vs upstream

| OpenCode V2 behavior | This extension |
| --- | --- |
| Read/list triggers upward discovery | `read` + `ls` tool results (pi's split of the same operation) |
| Nearest-first ordering | same |
| Dedup while entry in model-visible history | same (ledger derived from compaction-aware context) |
| Compaction/revert re-admits paths | same |
| Reading AGENTS.md itself does not self-inject | same |
| External reads skip discovery (dotfiles, `~/.pi/agent/skills/…`) | same — containment check on the resolved target (pi has no `externalDirectory` flag to reuse) |
| Ancestor/ambient files not re-injected | same (pi core loads them natively) |
| No nested-file watching | same |
| Ambient file change/removed narration mid-session | not cloned (pi has its own context-file reload semantics) |
| `Instructions from: <path>` message format | same |
| Discovery failure never fails the read | same |
