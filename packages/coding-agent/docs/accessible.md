# Accessible Mode (screen readers)

Accessible mode is a plain, line-oriented REPL for people who use screen readers. It
replaces the full-screen TUI — which relies on cursor repaints, redraws, and animated
spinners that screen readers announce repeatedly — with an **append-only, turn-based**
interaction: you type a line, press Enter, the agent responds in linear text, and the
prompt returns. It behaves like a normal interactive shell (`python`, `node`, `psql`).

## Starting it

```bash
pi --accessible
```

It also turns on automatically when the environment implies a non-visual terminal:

```bash
PI_ACCESSIBLE=1 pi     # explicit opt-in via environment
NO_TUI=1 pi            # generic "no TUI" signal
TERM=dumb pi           # auto-detected
```

`--repl` and `--no-tui` are accepted as aliases for `--accessible`. The explicit flag and
`PI_ACCESSIBLE` always win. Piped or redirected output still uses one-shot
[print mode](usage.md) (`pi -p`), so scripts are unaffected.

## How it behaves

- **Append-only, no repaint.** Output is written top-to-bottom in the order things happen.
  Nothing is ever redrawn in place, so a screen reader never re-reads changed content.
- **No spinners or animation, and no live counters.** Progress is conveyed with discrete
  lines (`» tool …`, `✓ / ✗`) rather than a moving indicator, and the continuously updating
  token/TPS/cache counters from the graphical footer are not shown. Those numbers are
  reported once instead, in the end-of-turn summary described below.
- **Text, not color.** Every state is labeled in words (`Error:`, `[interrupted]`). ANSI
  escape codes are stripped from all output.
- **Model reasoning is not shown** unless you ask for it. `/verbose` toggles it on and
  off (off at startup, or on from the start with `--verbose`): when on, each reasoning
  block is opened with a `Thinking.` line and then streams like any other reply text.
  Reasoning is never written to the resume transcript, so a replay does not read back
  the thinking of an earlier verbose turn.
- **Tool output is summarized rather than dumped.** Consecutive file operations are
  grouped by type (`» read: a.ts, b.ts`), and `bash` calls are reduced to
  `bash <command> <ok|failed>`, grouping a run of the same command with a count
  (`bash grep (5) ok`). The reported command is the first informative word, skipping
  navigation and wrapper prefixes so `cd pkg && grep …` reads as `bash grep ok`, not
  `bash cd ok`. Command arguments and output are not shown.
- **Minimal chrome.** Responses are printed directly (no `Assistant:` header). Each turn
  opens with one word confirming the model has taken over — `Working.` normally, or
  `Planning.` while plan mode is on — so the wait is announced before any reply arrives.
  Each turn then closes with one summary line, after which the `^` prompt returns for your
  next message:
  `Turn: 12 seconds. Context: 34k of 200k tokens (17 percent). Cache hits: 95 percent.`
  The cache-hit rate covers every provider request the turn made, not just the last one.
  Facts the session cannot supply are left out rather than reported as zero: no context
  clause without a model, and no cache clause when the turn never reached the provider or
  when the provider reports no cache activity at all (several do not report it, and a
  permanent `Cache hits: 0 percent` would read as a broken counter).
  Neither line is recorded in the resume transcript — both describe one live run.
- **Out-of-turn typing bell.** While the model is still responding, typing rings the
  terminal bell on every keystroke to signal that it is not yet your turn. The bell
  stops as soon as a prompt or question is waiting for your input.

## Example session

```text
Pi coding agent v0.80.3
Model: anthropic/claude-opus-4-5   Thinking: medium
Directory: /home/you/project
Type your message and press Enter. Type /help for commands, /quit to exit.

^ add a -V alias for --version and run the arg tests
Working.
I'll read the file, add the alias, then run the tests.

» read: args.ts
» edit: args.ts (1)
bash npm ok

Done. Added -V alongside --version; the arg-parser tests pass (12 of 12).
Turn: 41 seconds. Context: 18k of 200k tokens (9 percent). Cache hits: 87 percent.

^
```

When no model is configured yet, the banner reads `No model selected. Use /login or /model
to select a model.` — run `/login` to sign in.

## Commands

| Command | Action |
|---|---|
| `/help` | List commands and basic usage. |
| `/login` | Sign in. Choose **subscription** (OAuth) or **API key**, then a provider. |
| `/logout` | Remove a stored credential. |
| `/model [pattern]` | Show the current model, or switch it (numbered list, or match by pattern). |
| `/compact [notes]` | Summarize and shrink the conversation context. |
| `/session` | Show session info and stats. |
| `/usage` | Show the remaining GitHub Copilot premium request quota (also accepted as `/token`). |
| `/stream [block\|line]` | Show or switch how replies stream (see below). |
| `/verbose [on\|off]` | Show or switch whether the model's reasoning is printed (off by default; no argument toggles). |
| `/new` | Start a fresh session. |
| `/resume [number]` | List up to 10 recent sessions in this project and resume one by number. |
| `/resumeglobal [number]` | Like `/resume`, but list recent sessions across all projects. |
| `/quit` (or Ctrl+D, or `:q`) | Exit. |

### Streaming mode: line vs block

By default the agent's reply streams **line by line** as it is generated. Some screen
readers cope better when a reply arrives all at once, so you can switch to **block** mode,
where each assistant message is buffered and emitted as a single block when it finishes
(tool activity lines still appear in order):

```text
pi --accessible --block-output      # start in block mode (also PI_BLOCK_OUTPUT=1)

^ /stream block                     # or switch at any time
^ /stream line
^ /stream                           # show the current mode
```

### Resuming a session

`/resume` lists up to 10 recent sessions in the current project, newest first, and asks
for a number. `/resumeglobal` does the same across all projects. Pressing Enter without a
number (or entering a number that is not in the list) does not resume anything.

```text
^ /resume
Recent sessions in this project:
  1. fix the login race. (2 hours ago).
  2. draft release notes. (1 day ago).
Select a session number (Enter to cancel): 1
Resumed session: fix the login race. (2 hours ago).

^ /resume 2                          # resume the 2nd entry directly, no prompt
```

### Logging in

`/login` first asks how you want to authenticate:

```text
^ /login
Select authentication method:
  1. Use a subscription
  2. Use an API key
Enter a number (Enter to cancel): 1
Select a subscription provider:
  1. Anthropic
Enter a number (Enter to cancel): 1
Open this URL in a browser to authenticate:
https://claude.ai/oauth/authorize?...
Waiting for authentication…
Logged in to Anthropic. Selected anthropic/claude-opus-4-5. Credentials saved to ~/.pi/agent/auth.json.
```

- **Subscription** runs the provider's OAuth flow: the authorization URL (or a device
  code) is printed for you to open in a browser; if the provider asks for a pasted code,
  you type it at the prompt.
- **API key** prompts for the key and stores it. (Note: the key is echoed as you type, like
  any REPL input.)
- **Amazon Bedrock** uses AWS credentials rather than a single key — `/login` points you at
  the setup docs instead of prompting for a key.

Credentials are saved to `~/.pi/agent/auth.json`. `/logout` removes a stored credential
(environment variables and `models.json` are left untouched).

Anything that is not a command is sent to the agent. Extension-provided slash commands
work too.

## Keys

- **Enter** — send the current line.
- **Ctrl+C** — interrupt a running turn (the agent stops; you stay in the REPL). At an idle
  prompt, press Ctrl+C twice (or type `/quit`) to exit.
- **Ctrl+D** — exit at an empty prompt.

## Not yet supported

Session tree navigation (`/fork`, `/tree`), `/export` / `/share` / `/settings`,
image input, and autocomplete are not available in accessible mode yet — use the standard
TUI (`pi`) for those. Interactive prompts that extensions raise (confirm / select / input)
are rendered as plain text questions.
