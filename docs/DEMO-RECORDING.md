# Record the admission gate

The hook: **The fleet proposes. A human decides.**

This demo uses invented sessions and extracted proposals with the real admission,
review, and recall code. It runs locally without an API key or an LLM. No history
reader, sync daemon, or coding agent runs. The full `motif demo` remains available.

The gate holds new team **decision notes** out of recall until admitted. Raw source
sessions remain searchable and can appear under **From past sessions**, even after
a proposal is rejected. Do not promise an empty recall or that rejected text can
never reach an agent. The visible proof is that **What the team already decided**
appears only after admission, with the accepted rule marked verified.

## Build this checkout once

Requires Node.js 22 or later. Run these in the repository root:

```sh
npm install
npm run build
```

Use the local build for this change until a release containing `--gate` is
published. The npm package is `getmotif`; the executable is `motif`.

## Easiest rehearsal: one terminal

```sh
MOTIF_DEMO_DIR=/tmp/motif-gate-demo node packages/cli/dist/index.js demo --gate
```

The browser opens Review as the invented reviewer `you`. Return to the terminal
and press Enter for each of the five commands. Each Enter runs the real CLI
handler. Use `--auto --fast` to rehearse without input or pauses.

## Manual take: two terminals

In terminal 1, from the repository root:

```sh
MOTIF_DEMO_DIR=/tmp/motif-gate-demo node packages/cli/dist/index.js demo --gate --prepare
```

Leave this terminal running. The browser opens with both proposals pending.
In terminal 2:

```sh
source /tmp/motif-gate-demo/gate-env.sh
PS1='$ '
clear
motif memory review
```

The shell helper points `motif` at this build and the temporary demo database,
with all reader locations isolated. It does not change your regular configuration.
Start the recording with the two PROPOSED entries already visible. Then run:

```sh
motif recall "cache key tenant isolation" --budget 350
motif memory admit 1
motif memory reject 2
motif recall "cache key tenant isolation" --budget 350
motif memory review
```

IDs 1 and 2 belong to a fresh gate demo. The setup also prints the actual commands.

## A 45–60 second take

1. **0–10s:** Show Review's two PROPOSED entries and their source session IDs.
   Say: "Two agents proposed. Neither is an approved decision."
2. **10–20s:** Run the first recall. It has source excerpts but no decided-memory
   section. Say: "Evidence exists. The team has not accepted a rule yet."
3. **20–35s:** Admit 1, reject 2. Pause briefly after each command.
4. **35–50s:** Run recall again. Point to the new **What the team already decided**
   section and **verified · high confidence**. Say: "One reviewed decision, ready
   for the next agent. The rejected proposal stays in the record."
5. **50–60s:** Run Review again to show an empty inbox. Switch to the browser's
   Memory tab and open `cache-keys` to show verified and retired notes. Weave is
   an optional closing shot; this focused fixture is a small graph. Use the full
   demo separately if you want the larger team graph. There is no special
   admission glow animation.

Use a dark terminal with 20–24px text. On macOS, press Shift+Command+5, select
the terminal area, and start recording. Use the menu bar stop button to finish.
For a browser closing shot, select an area containing both windows or record the
whole screen. Run setup before recording so the first frame shows the proposals.
If the terminal prompt has extra information, `PS1='$ '` gives a clean prompt.

Suggested caption:

> The fleet proposes. A human decides.
> Proposed decisions wait for review. Accepted knowledge is ready for reuse.
> Motif. Self-hosted memory for coding agents.

## Another take / stop

Stop terminal 1 with Ctrl+C, then run the same setup command again. It recreates
only the demo directory, resetting both proposals. Source the helper again in
terminal 2. If port 4699 is occupied, add `--port 4702` to the setup command.

To remove the temporary demo after stopping the server:

```sh
MOTIF_DEMO_DIR=/tmp/motif-gate-demo node packages/cli/dist/index.js demo --clean
unset -f motif
```

Close terminal 2 to restore its original prompt. `--no-open` skips browser launch;
the temporary `dashboard-url.txt` file contains the local sign-in URL. Keep that
token out of recordings. Each fresh take creates new demo credentials.
