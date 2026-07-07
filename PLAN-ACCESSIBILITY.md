# PLAN: Accessible REPL Mode (screen-reader-friendly, non-TUI)

## Goal

Add a **plain, line-oriented input/output mode** to Pi so that visually impaired users
who rely on screen readers can use the coding agent. The full-screen TUI is hostile to
screen readers (alt-screen, in-place cursor repaints, differential redraws, animated
spinners, color-encoded meaning). This mode replaces all of that with an **append-only,
turn-based REPL**: you type a line, press Enter, the agent responds in linear text, and
the prompt returns — the way a normal interactive shell (`python`, `node`, `psql`) behaves.

Screen readers read the terminal's text as it is appended. Anything that rewrites already
printed content, moves the cursor, or emits continuous animation gets re-announced or
garbled. The single rule for this mode: **only ever append plain text lines; never repaint.**

## Decisions (confirmed with the user)

| Decision | Choice |
|---|---|
| **Approach** | **Additive.** New `accessible` mode *beside* the TUI. `pi` keeps the TUI; `pi --accessible` gets the REPL. ~0 lines deleted. Can be promoted to default later. |
| **Output streaming** | **Line-buffered streaming** of assistant text by default — flushed on newline boundaries. An opt-in **block mode** (`--block-output` / `PI_BLOCK_OUTPUT` / `/stream block`) buffers each whole assistant message and emits it at once (some screen readers prefer this). **Model thinking is never shown** — fully suppressed to reduce clutter. |
| **Tool output** | **Compact & summarized, never dumped.** Consecutive file tools (`read`/`edit`/…) are **grouped by type** onto one line each; `bash` shows its command (truncated if long) plus `ok`/`fail` and a **single** summary line. Full tool output is never printed. |
| **v1 scope** | **Core loop + essentials.** prompt→response→loop, Ctrl+C to interrupt a running turn, and text commands: `/quit`, `/new`, `/model`, `/compact`, `/session` (+ `/help`). Extension `confirm`/`select`/`input` prompts rendered as text. Everything else deferred. |
| **Activation** | `--accessible` flag, `PI_ACCESSIBLE=1` env, **and** auto-detect (`TERM=dumb`, `NO_TUI`, common screen-reader env signals). |

## Implementation status (v1 complete)

Implemented and verified on 2026-07-07:

- **New mode** in `src/modes/accessible/`: `types.ts`, `line-writer.ts`, `prompter.ts`,
  `event-renderer.ts`, `text-ui-context.ts`, `commands.ts`, `login.ts`, `model-label.ts`,
  `accessible-mode.ts`.
- **Low-clutter output**: no `Assistant:` header, no `[turn complete]` marker, `^`
  prompt, `/model` grouped by provider, token/TPS/cache status suppressed, and a
  "No model selected. Use /login or /model" banner (accessible mode can start without a model).
- **Streaming toggle**: `--block-output` / `PI_BLOCK_OUTPUT` / `/stream block|line` switches
  between line-by-line and whole-message-block output (`renderer.setBlockOutput`).
- **Auth**: `/login` (subscription/OAuth or API key) and `/logout` in `accessible/login.ts`,
  reusing `authStorage.login()` / `authStorage.set()` with readline-backed OAuth callbacks.
- **CLI wiring**: `--accessible` (+ `--repl` / `--no-tui` aliases) in `args.ts` and help;
  `AppMode` and `ExtensionMode` extended with `"accessible"`; `resolveAppMode` +
  `accessibleRequested` (flag / `PI_ACCESSIBLE` / `NO_TUI` / `TERM=dumb`) + dispatch branch
  + stdout gate in `main.ts`; export in `modes/index.ts`.
- **Docs**: `docs/accessible.md` (linked from `docs/docs.json`).
- **Tests** (`test/accessible-*.test.ts`, 70 tests): line-writer (ANSI strip / no control
  bytes), event-renderer (grouping, bash summaries, thinking suppressed, no-ANSI invariant),
  text-ui-context, commands, login (API-key + OAuth callbacks + logout), CLI wiring (arg
  parsing + `resolveAppMode` truth table), and an end-to-end loop test (real `AgentSession`
  via the faux-model harness) covering streaming render, `/quit`, Ctrl+C abort-without-exit,
  and idle double-Ctrl+C exit.
- **Verified**: full-repo typecheck (0 errors), biome clean, all accessible tests + affected
  existing suites green, and a live pty smoke test of `pi --accessible` (clean plain-text
  banner, `/help`, `/quit`; the only escape codes are readline's own input-line echo).

Deferred items remain as listed under "Explicitly out of scope for v1".

## Why this is very achievable

The agent core is already fully decoupled from the TUI. Two existing headless modes prove it:

- **`src/modes/print-mode.ts`** — one-shot: `session.subscribe()`, `session.prompt()`, print, exit. No TUI.
- **`src/modes/rpc/rpc-mode.ts`** — headless bidirectional protocol over stdin/stdout. It already
  implements the *entire* command surface (`prompt`, `steer`, `abort`, `set_model`, `compact`,
  `new_session`, …) **and a headless `ExtensionUIContext`** — without any TUI. Our REPL is
  essentially "RPC mode, but the wire protocol is human-readable text instead of JSON."

Central abstraction — `AgentSession` (`src/core/agent-session.ts`), UI-agnostic:

- `session.prompt(text, { images?, source })` → resolves when the turn is fully done.
- `session.subscribe((event: AgentSessionEvent) => void)` → the event stream to render.
- `session.steer()`, `session.followUp()`, `session.abort()`.
- `session.setModel()`, `cycleModel()`, `setThinkingLevel()`, `compact()`, `getSessionStats()`, `messages`, `model`, `isStreaming`, …
- `session.bindExtensions({ uiContext, mode, commandContextActions, onError })` → wires extensions and
  supplies the UI callbacks (`select`/`confirm`/`input`/`notify`/…) that the mode implements.

**No in-app permission system.** Pi runs tools with the user's own OS permissions (isolation is
via containerization, per `README.md`). There are **no tool-approval prompts** to design — a major
simplification versus other agents.

**`pi-tui` stays.** It is dual-purpose: the full-screen framework *and* a library of rendering
helpers (`Text`, `Markdown`, `truncateToWidth`, `visibleWidth`, terminal colors, `hyperlink`) that
the **core tools themselves import** (e.g. `core/tools/read.ts`, `core/tools/bash.ts`). We do **not**
delete `pi-tui`; we simply never start its interactive render loop in this mode, and we render events
to plain strings ourselves.

## Event model the renderer consumes

`AgentSessionEvent` = `AgentEvent` (from `pi-agent-core`, `agent/src/types.ts:413`) plus session events
(`agent-session.ts:127`). The relevant members:

- `message_update { message, assistantMessageEvent }` — streaming deltas. `AssistantMessageEvent`
  (`ai/src/types.ts:453`): `text_start/text_delta/text_end`, `thinking_start/thinking_delta/thinking_end`,
  `toolcall_start/toolcall_delta/toolcall_end`, `done`, `error`.
- `tool_execution_start { toolCallId, toolName, args }`
- `tool_execution_update { …, partialResult }`
- `tool_execution_end { toolCallId, toolName, result, isError }`
- `turn_start` / `turn_end { message, toolResults }`
- `agent_start` / `agent_end { messages, willRetry }`
- `compaction_start` / `compaction_end`, `auto_retry_start` / `auto_retry_end`,
  `thinking_level_changed`, `session_info_changed`, `queue_update`, `entry_appended`.

We do **not** need every event in v1 — see the mapping table below.

---

## Design of the accessible mode

New directory: **`src/modes/accessible/`**

```
src/modes/accessible/
  accessible-mode.ts      # runAccessibleMode(runtime, options) — the REPL loop
  event-renderer.ts       # AgentSessionEvent -> plain text lines (line-buffered)
  text-ui-context.ts      # ExtensionUIContext backed by readline prompts
  commands.ts             # slash-command dispatch table for v1
  line-writer.ts          # append-only stdout writer + line buffering helper
```

### 1. The REPL loop — `accessible-mode.ts`

Model it on `print-mode.ts` (skeleton: signal handlers, `rebindSession`, `subscribe`, dispose) but
loop instead of running once. Use Node's built-in **`readline`** in normal (cooked) line mode —
readline echoes input to the terminal in the way screen readers expect, gives free line editing,
history, and Ctrl+C handling.

```
export interface AccessibleModeOptions {
  initialMessage?: string;
  initialImages?: ImageContent[];
  initialMessages?: string[];
  verbose?: boolean;   // affects error verbosity/diagnostics only; NEVER surfaces model thinking
}

export async function runAccessibleMode(runtime: AgentSessionRuntime, options): Promise<number>
```

Loop outline:

1. `rebindSession()` — same shape as print/rpc: `session.bindExtensions({ uiContext: createTextUIContext(rl), mode: "accessible", commandContextActions, onError })`, then `unsubscribe = session.subscribe(renderer.handle)`.
   - `mode` — add `"accessible"` to the extension bind-mode union (see file changes). Reuse the same
     `commandContextActions` object print-mode builds (`waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, `reload`).
2. Print a short, screen-reader-friendly banner: app + version, active model, cwd, and
   "Type your message and press Enter. Type /help for commands, /quit to exit."
3. If `initialMessage` / `initialMessages` present, run them through the same submit path before prompting.
4. `rl.prompt()` with a stable, minimal prompt string (`"^ "`). On each submitted line:
   - Empty line → reprompt.
   - Starts with `/` → dispatch via `commands.ts` (see §4). Unknown `/x` that matches an extension
     command → `session.prompt(text)` (extensions consume slash input via prompt, per
     `interactive-mode.ts:isExtensionCommand`).
   - Otherwise → **await `session.prompt(line)`**. Because `prompt()` resolves when the whole turn
     (including tool calls and any follow-on assistant turns) is done, the loop is naturally
     turn-based: no new input is accepted until the agent is finished. The renderer streams output
     meanwhile. When it resolves, emit a clear end-of-turn marker and reprompt.
5. On `rl` `close` / EOF (Ctrl+D) → clean shutdown.

**Interrupt (Ctrl+C).** In readline, `SIGINT` fires the readline `"SIGINT"` event rather than killing
the process. Handle it contextually:
   - If a turn is streaming (`session.isStreaming`) → `await session.abort()`, print `"[interrupted]"`, reprompt. Do **not** exit.
   - If idle at an empty prompt → print a hint (`"(Ctrl+C again or /quit to exit)"`); second consecutive Ctrl+C exits.
This mirrors familiar REPL behavior and never traps the user.

**stdout discipline.** Non-interactive modes call `takeOverStdout()` (`core/output-guard.ts`) to
prevent stray library writes from corrupting the protocol. For the REPL we want readline to own the
TTY, so **do not** take over stdout the way RPC does; instead route all agent output through a single
`line-writer.ts` that writes to `process.stdout` and coordinates with readline (write output *above*
the current prompt line using `readline.clearLine`/`cursorTo` only to redraw the input line — or
simpler: since turns are serialized, the prompt isn't active while output streams, so plain
`stdout.write` is sufficient). Keep it append-only.

### 2. Event → text rendering — `event-renderer.ts`

A small stateful class subscribed to the session. It holds two kinds of state: a **text line
buffer** and a **pending tool group**.

**Text (line-buffered).** Accumulate `text_delta` in a buffer and flush completed lines (split on
`\n`; also flush on a size cap so a newline-free stream still emits progressively) so screen readers
get whole clauses, not single tokens. Flush the remainder on `text_end` / `message_end`.
**Model thinking (`thinking_start/delta/end`) is dropped entirely** — no tokens, no `[thinking…]`
marker, nothing. This is unconditional (not gated by `verbose`).

**Tools (grouped by type).** Do not render a start line then an end line per tool. Instead keep a
*pending group* keyed by tool category and accumulate consecutive same-category calls; flush the group
as one line when the run is interrupted by a different tool category, by assistant text, or by turn
end. `bash` and other one-off tools flush any pending file group first, then render on their own.

Rendering rules (all plain text, labeled prefixes — no color-only meaning, no spinners, no boxes):

| Event | Output |
|---|---|
| `text_delta` | append to line buffer; flush completed lines (no `Assistant:` header — printed directly) |
| `text_end` / `message_end` | flush remaining buffer |
| `thinking_*` | **ignored — never emitted** |
| file tools run (`read`/`edit`/`write`/`ls`/`grep`/`find`), grouped on flush | one line per category listing files/targets, e.g. `» read: args.ts, main.ts, sdk.ts` and `» edit: args.ts (1), main.ts (2)` (the count = replacements/edits). A **failed** file op breaks out of the group onto its own line: `» edit: args.ts — failed: <message>`. |
| `bash` start | `» bash: <command>` — command **truncated** to ~80 cols with `…` if longer |
| `bash` end (ok) | `  ✓ bash ok — <single summary line>` where the summary = last non-empty stdout line, ANSI-stripped, truncated. Omit the ` — …` if there is no output. **Full output is never printed.** |
| `bash` end (fail) | `  ✗ bash failed (exit <code>) — <single line>` (last stderr/stdout line or error message, truncated) |
| other one-off tool end | `» <name>: <short one-line result or ok/fail>` |
| turn resolves (`prompt()` returns) | flush pending group + buffer, then reprompt (no end-of-turn marker; the `^` prompt, prefixed with a blank line, separates turns) |
| `compaction_start/end` | `[compacting context…]` / `[context compacted] N → M tokens` |
| `auto_retry_start` | `[retrying (attempt n/m) after error: …]` |
| `message error` / `done reason=error` | `Error: <message>` (to stderr) |

Notes:
- **Strip ANSI escapes** from every tool-derived string before printing (tools may embed colors via
  `pi-tui`). Screen readers must never receive escape sequences. Provide `stripAnsi()` in `line-writer.ts`.
- **Grouping is per run, per category.** `read` then `read` then `edit` → two lines (`» read: …`,
  `» edit: …`). `read`, `bash`, `read` → three lines (the bash flushes the first read group; the
  second read starts a fresh group). Assistant text between tool runs also flushes the group so
  reading order stays truthful.
- **No animated working indicator.** No spinner, ever. The streamed text plus `[turn complete]` is the
  only progress feedback. (Optionally a single static `Working…` line after a long silence — v1 omits it.)
- The single bash summary line and any counts must be **honest** — never imply success on failure.

### 3. Extension UI over text — `text-ui-context.ts`

Implement `ExtensionUIContext` (`core/extensions/types.ts:126`) exactly as `rpc-mode.ts` does, but back
the three interactive methods with readline prompts instead of JSON round-trips:

- `select(title, options)` → print title + a numbered list, read a number via `rl.question`, return the chosen string (Enter/empty or `q` → `undefined` = cancelled). Honor `opts.signal`/`opts.timeout` like RPC's `createDialogPromise`.
- `confirm(title, message)` → print, read `[y/N]`, return boolean.
- `input(title, placeholder)` → print title, read a line, return it (empty → cancelled).
- `notify(message, type)` → print `Note:` / `Warning:` / `Error:` prefixed line.
- `setStatus`, `setTitle` → **no-ops**. Status is footer chrome (token/TPS/cache counters, git branch); it updates constantly and is pure clutter for a screen reader.
- **TUI-only methods** (`setWidget`, `setFooter`, `setHeader`, `setWorkingMessage`,
  `setWorkingVisible`, `setWorkingIndicator`, `setHiddenThinkingLabel`, `custom`,
  `addAutocompleteProvider`, `setEditorComponent`, editor/theme getters) → **no-ops / safe defaults**,
  copied straight from `rpc-mode.ts`'s already-written implementations. `onTerminalInput` → `() => {}`.

Because the reads share the same readline instance as the main loop, guard against concurrent prompts
(extension prompts only occur mid-turn while the main loop is blocked in `await session.prompt`, so
there is no contention — but assert/serialize to be safe).

### 4. Command surface — `commands.ts`

v1 dispatch table (parse `/name [args]`):

| Command | Action |
|---|---|
| `/help` | List available commands + basic usage. |
| `/quit`, `/exit` | Clean shutdown, exit 0. |
| `/login` | Choose subscription (OAuth) or API key, then a provider; text-backed `authStorage.login()` / `authStorage.set()`. |
| `/logout` | Pick a stored credential and remove it (`authStorage.logout()`). |
| `/new` | `runtime.newSession()` then `rebindSession()`; announce new session. |
| `/model [pattern]` | No arg → print current + list available (`session.modelRegistry.getAvailable()`), read a number to pick, `session.setModel()`. With arg → resolve + set. (Text selector; not the TUI selector.) |
| `/compact [instructions]` | `session.compact(instructions)`; announce result. |
| `/session` | Print `session.getSessionStats()` / `get_state` fields as labeled lines (model, thinking, message count, session id/name, file). |
| `/stream [block\|line]` | Show or toggle streaming mode via `renderer.setBlockOutput()`. |
| unknown `/x` matching an extension command | fall through to `session.prompt(text)`. |
| other unknown | `Unknown command: /x. Type /help.` |

All command handlers reuse `AgentSession` / `runtime` methods already exercised by `rpc-mode.ts` — no
new session capabilities needed. `/login` + `/logout` (`accessible/login.ts`) reuse the same auth
logic as the TUI (`authStorage.login()` OAuth callbacks / `authStorage.set()` for API keys), driven
through readline text prompts. Deferred to later phases: `/resume`, `/fork`, `/tree`, `/clone`,
`/export`, `/share`, `/settings`, `/thinking`, `/scoped-models`, image input.

---

## Wiring into the CLI

### `src/cli/args.ts`
- Add `accessible?: boolean` to the `Args` interface.
- In the parse loop (`args.ts:71`), add `else if (arg === "--accessible")` → `result.accessible = true`.
  (Optionally accept `--repl` / `--no-tui` as aliases.)
- Add the flag to `printHelp()`.

### `src/core/project-trust.ts`
- Extend `AppMode`: `"interactive" | "print" | "json" | "rpc" | "accessible"` (`project-trust.ts:12`).
  Audit switches on `AppMode` (trust prompt mode, extension bind `mode`) and handle `"accessible"`
  like `"interactive"` for trust prompting (it *is* interactive — it can ask the user via readline).

### `src/main.ts` — `resolveAppMode()` (`main.ts:100`)
Add accessible detection **before** the print/TTY checks so it wins when requested, but still yields
to `print` when stdout isn't a TTY (piped output should stay one-shot):

```
function resolveAppMode(parsed, stdinIsTTY, stdoutIsTTY): AppMode {
  if (parsed.mode === "rpc") return "rpc";
  if (parsed.mode === "json") return "json";
  if (parsed.print || !stdinIsTTY || !stdoutIsTTY) return "print";
  if (accessibleRequested(parsed)) return "accessible";   // NEW
  return "interactive";
}
```

`accessibleRequested(parsed)` returns true if any of: `parsed.accessible`,
`PI_ACCESSIBLE` truthy (reuse `isTruthyEnvFlag`), `process.env.NO_TUI`, `process.env.TERM === "dumb"`,
or a known screen-reader signal. Keep the detector in one small helper so the heuristics are
auditable and easy to tune.

Dispatch (`main.ts:806`): add a branch alongside `interactive`:

```
} else if (appMode === "accessible") {
  printTimings();
  const exitCode = await runAccessibleMode(runtime, {
    initialMessage, initialImages, initialMessages: parsed.messages, verbose: parsed.verbose,
  });
  stopThemeWatcher();
  if (exitCode !== 0) process.exitCode = exitCode;
  return;
}
```

Also treat `"accessible"` like `"interactive"` (not like print) at the existing
`appMode === "interactive"` gates that matter: the "no models available" hard-exit at `main.ts:795`
should still apply (accessible needs a model); `shouldTakeOverStdout` (`main.ts:535`) should **not**
take over stdout for accessible mode (readline owns the TTY); `stdinContent` piped-input handling
(`main.ts:763`) already coerces to `print` when stdin isn't a TTY, which is correct.
`initTheme(..., appMode === "interactive")` → pass `false` for accessible (no theme watcher / no ANSI theming needed).

### `src/modes/index.ts`
Export `runAccessibleMode` and `AccessibleModeOptions`.

### Extension bind `mode`
`bindExtensions({ mode })` currently accepts `"interactive" | "print" | "json" | "rpc"`. Add
`"accessible"`. Extensions branch on this to decide UI richness; treating it as its own value lets
extension authors tailor text output, and keeps the door open. Where extension code switches on
`mode`, default `"accessible"` to the `"rpc"`/`"print"` (non-TUI) branch.

---

## Accessibility guidelines (the bar every line of this mode must meet)

- **Append-only.** Never move the cursor to rewrite printed content. No alt-screen
  (`smcup`/`rmcup`), no `clearLine`/`cursorTo` except readline's own input-line management.
- **No animation.** No spinners, progress bars, or repeating status. A screen reader announces every
  repaint; animation = continuous noise.
- **Text, not color.** Every state distinction has a textual label/prefix (`Error:`, `» tool`, `✓`,
  `[turn complete]`). Color, if any, is decorative only and safe to strip.
- **Linear reading order.** Output top-to-bottom in the order things happen. One concept per line
  where practical.
- **No model reasoning, no output dumps.** Thinking tokens are never shown; tool output is summarized
  (grouped file ops, single-line bash results), never dumped — this keeps the transcript short enough
  to listen to.
- **No escape sequences in content.** Strip ANSI from tool output.
- **Explicit boundaries.** Announce turn start/end so the user knows when it's their turn to type.
- **Never trap input.** Ctrl+C interrupts a turn (not the process); Ctrl+D / `/quit` exits cleanly.
- **Bounded, honest output.** Truncate long tool results and *say so*; never silently drop.

---

## Testing strategy

- **Unit — `event-renderer.ts`:** feed synthetic `AgentSessionEvent` sequences (streaming text across
  chunk boundaries, tool start/end ok+error, thinking on/off, compaction, retry) and assert exact
  plain-text output. Assert **no ANSI** and **no cursor-control** bytes are ever emitted.
- **Unit — `commands.ts`:** dispatch table routing, unknown-command fallthrough to `prompt`.
- **Unit — `text-ui-context.ts`:** `select`/`confirm`/`input` parsing (valid pick, cancel, timeout,
  aborted signal) with a mocked readline.
- **Integration:** drive `runAccessibleMode` with a stub `AgentSession` (or the existing test session
  harness used by print/rpc tests) over a scripted stdin; assert the transcript is a clean linear log
  and Ctrl+C aborts without exiting.
- **Manual / a11y:** run under a real screen reader (NVDA on Windows, VoiceOver on macOS, Orca on
  Linux) and confirm streamed responses, tool activity, and prompts are announced sensibly. Verify
  `TERM=dumb pi` and `PI_ACCESSIBLE=1 pi` auto-select the mode.
- Follow repo conventions in `AGENTS.md`; add tests under the coding-agent package's existing
  `vitest` setup (`npm run test`).

---

## Phased delivery

- **Phase 1 — Skeleton & dispatch.** `args.ts` flag, `AppMode`, `resolveAppMode` + `accessibleRequested`,
  `main.ts` dispatch branch, `modes/index.ts` export, empty `runAccessibleMode` that loops
  prompt→`session.prompt`→print final assistant text (reusing print-mode's final-text logic). Ships a
  working, if plain, REPL.
- **Phase 2 — Streaming renderer.** `event-renderer.ts` with line-buffered assistant text (thinking
  dropped), by-type tool grouping, bash command truncation + single-line ok/fail summary, ANSI
  stripping, and turn markers. Subscribe it in the loop.
- **Phase 3 — Interrupt & signals.** readline `SIGINT` → `session.abort()` semantics; clean EOF/`/quit`.
- **Phase 4 — Commands.** `commands.ts` (`/help /quit /new /model /compact /session`) + extension-command fallthrough.
- **Phase 5 — Extension UI.** `text-ui-context.ts` (`select/confirm/input/notify`), rest no-ops from RPC.
- **Phase 6 — Auto-detect polish & docs.** Tune detection heuristics; add a docs page under
  `packages/coding-agent/docs/`; note the flag in help and README.

---

## Parallelization with subagents

The phases above are a *linear* reading. The work actually forms a **fan-out**: after one small
foundation step, five work packages proceed in parallel, then a single integrator wires them together.
The trick that makes this safe is to **freeze the seams first** (shared interfaces + test fixtures) so
each agent codes against a contract, not against another agent's in-progress file.

### Golden rule for every subagent

**Every work package ships with its own tests, and is not "done" until they pass.** Concretely, an
agent's task is complete only when, for the files it owns:

1. `npx vitest --run <its test files>` is green, **and**
2. `npx tsgo --noEmit` (repo typecheck) passes, **and**
3. `npx biome check` passes for its files (repo lint/format gate, per `AGENTS.md`).

Because each package owns a near-disjoint set of files and depends only on frozen interfaces, an agent
can develop and verify in isolation without the rest of the mode existing yet — using the shared test
doubles from Stage 0. **No mocking of ad-hoc internals**: test against the real interfaces with the
shared fakes so the integration step has no surprises.

### Dependency graph

```
              ┌─────────────────────────────────────────────────────┐
   Stage 0 ──►│  WP1 line-writer      (no deps beyond Stage 0)       │──┐
  (contracts  │  WP2 event-renderer   (deps: LineWriter iface)       │  │
   + fixtures)│  WP3 text-ui-context  (deps: Prompter iface)         │  ├─► WP7 accessible-mode ─► WP8
   BLOCKS ALL │  WP4 commands         (deps: session/runtime, Writer)│  │   (integrator; needs      (a11y
              │  WP5 cli-wiring       (deps: runAccessibleMode stub) │  │    WP1–WP4 impls)          + docs)
              └─────────────────────────────────────────────────────┘──┘
   WP1–WP5 run fully in parallel. WP5 can even merge before WP7 exists (it targets the stub).
```

### Stage 0 — foundation (one agent, small, merges first; BLOCKING)

Delivers the contracts and the shared test harness everything else builds on. Nothing else starts
until this lands on the branch.

- **`src/modes/accessible/types.ts`** — the frozen seams:
  - `AccessibleModeOptions` and the `runAccessibleMode(runtime, options): Promise<number>` signature (a stub body throwing `notImplemented` is fine for now).
  - `LineWriter` — the output sink: `{ line(text: string): void; blank(): void; error(text: string): void }`.
  - `Prompter` — the readline seam (so the loop and the UI context are testable without a real TTY): `{ question(query: string): Promise<string>; setPrompt(p: string): void; prompt(): void; write(s: string): void; onSigint(cb): void; onClose(cb): void; close(): void }`.
  - `EventRenderer` contract — `{ handle(event: AgentSessionEvent): void; endTurn(): void }`.
  - `CommandContext` (`{ session, runtime, writer, prompter, rebindSession, requestExit }`) and `CommandResult` (`{ kind: "handled" | "sendAsPrompt" | "exit" | "unknown" }`), plus the `CommandDispatcher` contract.
- **`src/modes/accessible/test-support.ts`** — shared fakes used by *all* WPs' tests:
  - `createRecordingWriter()` → a `LineWriter` that records every emitted line into an array for exact-output assertions (and asserts append-only: no cursor/ANSI control bytes).
  - `createFakePrompter(scriptedInputs: string[])` → a `Prompter` that returns queued answers and can fire a scripted SIGINT.
  - `createStubSession(overrides?)` / `createStubRuntime(overrides?)` → minimal stand-ins implementing the subset of `AgentSession` / `AgentSessionRuntime` the mode calls (`prompt`, `subscribe`, `abort`, `isStreaming`, `setModel`, `modelRegistry.getAvailable`, `compact`, `getSessionStats`, `bindExtensions`, `newSession`, …), with an `emit(event)` helper so tests can drive synthetic event streams.
- **Tests (required):** a smoke test that the fixtures themselves behave (recording writer captures lines; fake prompter dequeues; stub session `emit` fans out to subscribers).
- **Done when:** typecheck + lint pass and the fixtures are importable. This is the contract other agents import.

### Work packages (WP1–WP5 run in parallel after Stage 0)

| WP | Owns (files) | Depends on | Deliverable | Tests it must write (required) |
|----|--------------|-----------|-------------|-------------------------------|
| **WP1 line-writer** | `accessible/line-writer.ts` | Stage 0 (`LineWriter`) | Concrete append-only writer over a stream + `stripAnsi()`; line buffering with newline **and** size-cap flush | ANSI stripped; buffer flushes on `\n` and at size cap; **never emits cursor-control/alt-screen bytes**; partial line held until flushed |
| **WP2 event-renderer** | `accessible/event-renderer.ts` | Stage 0 (`LineWriter`, event types) | The §2 renderer: line-buffered text, thinking dropped, by-type file-tool grouping, bash cmd truncation + single ok/fail line, turn markers, retry/compaction/error lines | Feed synthetic `AgentSessionEvent` sequences → assert **exact** recorded lines: text across chunk boundaries; `read`,`read`,`edit` → 2 grouped lines; `read`,`bash`,`read` → 3 lines; failed file op breaks out; bash ok/fail summary line; **thinking events produce zero output**; assert no ANSI ever |
| **WP3 text-ui-context** | `accessible/text-ui-context.ts` | Stage 0 (`Prompter`) | `ExtensionUIContext` via `Prompter`: `select`/`confirm`/`input`/`notify`; all TUI-only methods no-op (copied from `rpc-mode.ts`) | `select` valid pick / cancel / out-of-range; `confirm` y/N parsing; `input` empty→cancel; `notify` prefixes; `opts.signal` aborted + `opts.timeout` resolve to defaults (mirror RPC `createDialogPromise`) |
| **WP4 commands** | `accessible/commands.ts` | Stage 0 (`CommandContext`, stub session/runtime) | `/help /quit /new /model /compact /session` dispatch + unknown-`/x`→`sendAsPrompt` fallthrough | Each command routes to the right session/runtime call (via stub spies); `/model` no-arg lists + picks by number; unknown `/foo` → `sendAsPrompt`; `/quit` → `exit`; non-slash line → `sendAsPrompt` |
| **WP5 cli-wiring** | `cli/args.ts`, `core/project-trust.ts` (`AppMode`), `main.ts` (`resolveAppMode`+`accessibleRequested`+dispatch+gates), `modes/index.ts`, extension bind-`mode` union | Stage 0 (`runAccessibleMode` stub signature) | `--accessible` flag+help; `AppMode` extended; `resolveAppMode`/`accessibleRequested`; dispatch branch; stdout/theme/no-model gates | `parseArgs` sets `accessible`; `resolveAppMode` truth table (rpc/json/print/accessible/interactive incl. TTY + `--print` precedence); `accessibleRequested` matches `--accessible`, `PI_ACCESSIBLE`, `NO_TUI`, `TERM=dumb` and ignores others |

Each WP is one file (+ its `*.test.ts`) except WP5, which is small edits across CLI files that no other
WP touches — so conflicts are near-zero. Agents may optionally run in isolated **git worktrees**; not
required given the disjoint file ownership.

### WP7 — integrator (after WP1–WP4 land)

- **`src/modes/accessible/accessible-mode.ts`** — replaces the Stage-0 stub with the real loop: build a
  `NodeReadlinePrompter` (concrete `Prompter` over Node `readline`), a real `LineWriter`, the renderer,
  the text-ui-context, and the command dispatcher; run the `rebindSession` + `subscribe` +
  prompt-loop + Ctrl+C/EOF logic from §1.
- **Tests (required, integration):** drive `runAccessibleMode` with `createFakePrompter` (scripted
  lines incl. `/help`, a plain prompt, `/quit`) and `createStubSession` (scripted event stream); assert
  the full recorded transcript is a clean linear log with correct `Assistant:`/tool/`[turn complete]`
  ordering; assert a scripted **SIGINT during streaming** calls `session.abort()` and does **not** exit,
  while SIGINT at idle then EOF exits cleanly.
- **Done when:** integration tests + typecheck + lint pass and `pi --accessible` runs end-to-end.

### WP8 — polish & docs (after WP7)

Manual screen-reader passes (NVDA / VoiceOver / Orca), auto-detect heuristic tuning, docs page under
`packages/coding-agent/docs/`, README/help note. Non-code a11y verification lives here (can't be unit-tested).

### Suggested assignment for a workflow

- 1 agent → **Stage 0** (blocking), then it can pick up **WP7** later.
- Fan out **WP1, WP2, WP3, WP4, WP5** to 5 agents in parallel (each self-verifies via the golden rule).
- 1 agent → **WP7** once WP1–WP4 are merged; then **WP8**.
- Optional adversarial reviewer agent per WP: re-run the WP's tests and assert the accessibility
  invariants (no ANSI, no cursor control, thinking never emitted) hold against fresh synthetic inputs.

## Files touched (summary)

**New:** `src/modes/accessible/{accessible-mode,event-renderer,text-ui-context,commands,line-writer}.ts`
(+ tests).

**Edited:** `src/cli/args.ts` (flag + help), `src/core/project-trust.ts` (`AppMode`), `src/main.ts`
(`resolveAppMode`, `accessibleRequested`, dispatch, stdout/theme/no-model gates), `src/modes/index.ts`
(export), extension bind-`mode` union + any `AppMode`/mode switches to handle `"accessible"`.

**Not touched / not deleted:** the entire `modes/interactive/` TUI, `pi-tui` package, `AgentSession`
core, tools. This mode is purely additive.

## Explicitly out of scope for v1 (future work)

Image/paste input, autocomplete, session tree navigation (`/tree`, `/fork`, `/clone`, `/resume`),
`/export` / `/share` / `/settings`, scoped-model cycling, custom extension widgets/footers,
and promoting accessible mode to the default (deferred pending real screen-reader user feedback).

## Open risks / things to watch

- **readline + streamed output interleaving.** Because turns are serialized (`await session.prompt`),
  the input line isn't active while output streams, so plain appends are safe. If we later allow
  typing during a turn (steering), we'll need `readline`'s write-above-prompt handling — revisit then.
- **Extension prompts mid-turn** share the readline instance; safe today because the main loop is
  awaiting, but add a guard so two prompts can't open at once.
- **Line-buffering vs. very long single-line output** (e.g. minified content): cap buffer length and
  flush on size as well as newline so a token stream without newlines still emits progressively.
- **Auto-detection false positives/negatives.** Keep heuristics in one auditable helper; the explicit
  `--accessible` / `PI_ACCESSIBLE` always wins and `--tui`-style override could be added if needed.
