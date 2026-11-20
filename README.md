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

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `minAnswerChars` | `80` | Skip suggestions after answers shorter than this |
| `suggestSkills` | `true` | Tell the suggester which skills and slash commands the session has |
