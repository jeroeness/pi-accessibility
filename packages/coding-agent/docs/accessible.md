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
- **No spinners or animation.** Progress is conveyed with discrete lines
  (`» tool …`, `✓ / ✗`, `[turn complete]`) rather than a moving indicator.
- **Text, not color.** Every state is labeled in words (`Assistant:`, `Error:`,
  `[interrupted]`, `[turn complete]`). ANSI escape codes are stripped from all output.
- **Model thinking is not shown**, and tool output is summarized rather than dumped:
  consecutive file operations are grouped by type (`» read: a.ts, b.ts`), and `bash`
  shows its command plus a single `ok`/`fail` summary line.
- **Turn boundaries are explicit.** After each response you see `[turn complete]` and then
  the `>` prompt, so you always know when it is your turn to type.

## Example session

```text
Pi coding agent v0.80.3
Model: anthropic/claude-opus-4-5   Thinking: medium
Directory: /home/you/project
Type your message and press Enter. Type /help for commands, /quit to exit.

> add a -V alias for --version and run the arg tests

Assistant:
I'll read the file, add the alias, then run the tests.

» read: args.ts
» edit: args.ts (1)
» bash: npm run test -- args
  ✓ bash ok — 12 passed (12)

Assistant:
Done. Added -V alongside --version; the arg-parser tests pass (12 of 12).

[turn complete]

>
```

## Commands

| Command | Action |
|---|---|
| `/help` | List commands and basic usage. |
| `/login` | Sign in. Choose **subscription** (OAuth) or **API key**, then a provider. |
| `/logout` | Remove a stored credential. |
| `/model [pattern]` | Show the current model, or switch it (numbered list, or match by pattern). |
| `/compact [notes]` | Summarize and shrink the conversation context. |
| `/session` | Show session info and stats. |
| `/new` | Start a fresh session. |
| `/quit` (or Ctrl+D) | Exit. |

### Logging in

`/login` first asks how you want to authenticate:

```text
> /login
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

Session tree navigation (`/fork`, `/tree`, `/resume`), `/export` / `/share` / `/settings`,
image input, and autocomplete are not available in accessible mode yet — use the standard
TUI (`pi`) for those. Interactive prompts that extensions raise (confirm / select / input)
are rendered as plain text questions.
