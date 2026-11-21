# next-steps (local fork)

Local fork of `next-steps@claude-community` 1.0.0 (Thariq Shihipar, MIT). After each turn it suggests up to three next prompts above the input box.

```
next:
  1: run the tests you just wrote (added)
  2: do the same for the settings page
  3: /code-review high
  9: add all
  0: dismiss
  add another: press its number now (after you edit the draft: ctrl+x tab first)
```

## What the fork changes

- **Pick several.** Picking a suggestion no longer hides the list. The first pick fills an empty prompt box; each further pick is added on a new line, so the draft can hold several suggestions. Picked rows show `(added)`. Picking a row whose text is still in the draft does nothing (a toast says so); if you deleted it from the draft, you can pick it again.
- **Add all.** `9` (shown when there are two or more suggestions) adds every suggestion not already in the draft, in list order, in one go, and marks them all.
- **Keys.** In an empty prompt box, a bare `1`/`2`/`3`/`9`/`0` presses the row (Claude Code's own band hotkeys). After a pick, keep typing numbers: while the draft is exactly what the plugin last put there, a number typed at its end picks from the list (`0` dismisses) and is not typed (a `prompt.edit` hook). A short burst of numbers (up to four, folded into one edit) picks each in order. Any other key, a paste, a cursor move or a number past the list types as usual and ends this until the next pick. After you have edited the draft, press `ctrl+x tab` to focus the list, then the number, or click the row.
- **`/next`** shows the last list again after `0` or after sending, with the picks still marked. A new list replaces it when the next answer is long enough (`minAnswerChars`); an answer with nothing to suggest clears it.
- **`/next-compare [turns]`** (test mode): for the next answers (default 5, at most 20; `/next-compare off` stops) it also asks Haiku through `$.model.complete`, giving it only your last prompt (after any number swap) and the last answer, and draws both lists as one placed transcript row, like the list (`1 fork : …` with `haiku: …` under it, labels fixed and each text wrapping under itself), with each request's time and tokens, in place of the list's row. Numbers still pick from the fork list. Each turn costs one extra Haiku request with no cache. A reload turns it off.
- **Survives `/reload-plugins`.** The list, its picks and whether it is showing are kept in the session's `$.state` (`next-steps.list`, shape `list-1`, contract in `types/index.d.ts`) and read back when a reload runs `session.start` again. So a number sent from a phone right after a reload still swaps, and `/next` still has the list. It is read back only in the session that saved it (the session id is stored with it), and `/clear` drops it, so a number sent after a `/clear` is never swapped for old suggestions. Change the shape tag when the saved fields change: the old value then reads as absent.
- **From a phone (Heeler).** Heeler sends text with herdr's `agent.prompt`, which types it as a bracketed paste and then presses Enter (checked 2026-11-21: `ESC[200~3ESC[201~` then `\r`). The number hotkeys never see a paste. So each new list is also printed into the transcript as text, full prompt text included (`printSuggestions`, default on), and a prompt made only of list numbers, sent while the list is up, is swapped for those suggestions before Claude reads it: `3` for one, `1,2`, `1 2` or `12` for several (one per line, in the order typed, each once), `9` for all. The transcript shows what was typed first (`next: typed "1,2"`, the only record of the raw input, since the prompt itself shows the swapped text), then `next 3 sent: …` for each. A number past the list, or anything else (`3.`, `option 3`, `19`), goes through as typed. A slash-command suggestion can't be swapped in, because by then the command check has run and the model would get `/name` as plain text, and it can't be combined with others either. If a pick includes one, nothing is sent and the line to send on its own is printed. `/next` also prints the list. Only the person's own sends are swapped (composer or Remote Control), not those from plugins, peers or notifications.
- Combining a slash command with other text shows a warning toast: only a prompt that starts with `/name` runs the command, and the rest of the draft becomes its arguments.

The plugin never sends a prompt itself. Sending hides the list.

## Install

The folder above this one is a local marketplace (`local-plugins`), read straight from disk:

```sh
claude plugin marketplace add ~/.claude/local-plugins
claude plugin disable next-steps@claude-community
claude plugin install next-steps@local-plugins
```

After an edit, run `/reload-plugins` in a session. Check with `claude plugin validate .`, `claude plugin test .`.

From the heeler-kit zip, this folder is its own one-plugin marketplace (`heeler-kit`), and `bash install.sh --with-next-steps` does the steps above for it: it copies the folder to `~/.local/share/heeler-kit/next-steps`, adds that as a marketplace, turns off `next-steps@claude-community` if it is on, and installs `next-steps@heeler-kit`. Run it again after unpacking a newer zip.

MIT licence (see LICENSE), from next-steps@claude-community by Thariq Shihipar.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `minAnswerChars` | `80` | Skip suggestions after answers shorter than this |
| `suggestSkills` | `true` | Tell the suggester which skills and slash commands the session has |
| `printSuggestions` | `true` | Also draw each new list in the transcript as one row (`$.ui.place`: header, then one suggestion per line), for a remote view of the pane (Heeler). Display only: the transcript file holds none and `--resume` brings none back; the last 20 lists are kept in `$.state`, so rows still draw after a reload. Falls back to log lines if the row can't be placed |
| `cacheCheckTokens` | `20000` | The fork asks for low effort. If one fork writes at least this many tokens to the cache, and more than it reads, low effort made a second cache copy of the conversation (the model takes effort per request, not per message): low effort then stays off for the session (kept in `$.state`, so a reload doesn't retry it), with one line in the transcript |
