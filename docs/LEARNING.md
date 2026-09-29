# Learning from agent experience

Motif keeps sessions, memory, human rulings and actions in one experience graph.
Learning adds a decision projection over that record. It does not replace recall,
ask, handoff, the review inbox, or Weaver.

## Try the complete pipeline

```sh
motif demo --learn
```

This creates ten hand-written native traces, reads them with the Codex reader,
ingests them through the authenticated session API, extracts decisions, exports
a dataset, and evaluates a majority baseline. The output directory is printed.
The usual demo directory is reset on each run; use `MOTIF_DEMO_DIR` to choose
another disposable directory. No real history, agent, trace command, model, or
external service runs. Synthetic evaluation scores are not product benchmarks.

## Use already-ingested experience

```sh
motif decisions extract command_recovery --project /workspace/app
motif decisions --project /workspace/app
motif decisions show <id> --project /workspace/app --json
motif dataset command_recovery --project /workspace/app --out ./recovery-dataset
motif eval ./recovery-dataset --baseline majority --json
```

These commands use an existing member identity and server connection, or an
existing local database and valid member token. They never scan agent homes or
automatically enable synchronization. Project filters match the stored project
path. New data or rewritten sources require another extraction before export.

The default scope is `team`. Add `--scope personal` to each command to analyze
only your own personal sessions. Team exports never combine them with personal
examples. New output directories are created privately and never overwritten.

## First recipe: command recovery

The decision boundary is an explicitly failed command. The observed choice is
the next direct command attempt in the same command family and working directory:

- `retry_unchanged`: the command string is unchanged after trimming.
- `revise_command`: the command string changed.

The two choices are defined by this recipe. They are not a captured menu of
everything the agent could have done. Cases where it asked the user, inspected a
file, edited code, or stopped are outside this recipe. Results describe this
selected population, not all failure handling.

Input features are the failed command, its exit code, and up to 2,000 characters
of its reported output. Post-failure commentary, the recovery command, and its
outcome never enter the input. Session titles, final file lists, model reasoning,
and later memory are not used as decision-time features.

Supported calls are `Bash`, `exec_command`, `shell_command`, and simple `shell`
wrappers. The initial command grammar accepts simple npm test/run commands,
`npx vitest run`, cargo test/check/build, and node/python script invocations.
Compound shell commands, redirects, pipelines, substitutions and unsupported
arguments are deliberately excluded. Utilities such as search, where nonzero
status can mean an ordinary answer, are outside this recipe.

Outcome evidence must contain an explicit terminal process exit code. Readers
retain supported structured receipts (including JSON output with
`metadata.exit_code`) and recognized native process-result envelopes. Tool-level
`is_error` is preserved separately: it alone is not a process exit code. Arbitrary
stdout saying "passed" or "success" is not parsed into an outcome. Older records
with supported receipt text can qualify; otherwise missing evidence stays unknown.

The reader version causes one full resend after upgrading. `motif sync --force`
also resends full normalized sessions. Content hashes detect rewritten message
receipts even when their IDs stay the same. Only use synchronization on the real
history you already intend to ingest; the learning commands themselves never do it.

## Quality and provenance

Every decision includes source session identity, message IDs, ordered positions,
content hashes, the state cutoff, extractor version, action and outcome.
Candidate decisions with missing recovery outcomes remain inspectable but do not
enter the dataset. Parse errors, ambiguous call/result joins, overlapping calls,
copied handoff histories and redacted evidence are excluded conservatively.
Resumed handoff sessions are excluded as a whole in v1; partial copied-prefix
recovery is future work.

Failed recovery attempts remain eligible observations. The target is explicitly
`observed-behavior`, never "optimal action". A zero exit code is not a claim that
tests were comprehensive, the task succeeded, or the chosen action was best.
Uploaded receipts are source-reported evidence, not independently attested runs.

Source-session memory reviews and Weaver resolutions are inspectable as feedback.
Disputed, retired, conflicted or superseded source notes quarantine the session's
examples. This intentionally conservative policy does not claim an unrelated
note labels a particular command. Reviews are re-read at inspection/export time;
they do not silently change an existing exported snapshot. Human confirmation
does not convert an observed action into a gold label.

Examples are invalidated when messages change. Deleting a source cascades through
its stored decisions, evidence and scan records. Current source visibility is
checked for every list, detail and export. Already-exported files are independent
snapshots: later deletion, privacy changes or rulings cannot retract copies.
Re-export before relying on current eligibility, and manage exported data with
the same care as its source sessions.

## Dataset artifacts

An export directory contains:

- `dataset.json`: canonical examples and manifest, consumed by the evaluator.
- `manifest.json`: schema, recipe, quality policy, scope, exclusions, grouping
  policy and content hash.
- `examples.jsonl`: complete inspectable examples, including provenance/outcomes.
- `train.jsonl`: training inputs and observed-choice targets.
- `test-inputs.jsonl`: held-out inputs and IDs, without targets or future evidence.

The schema is `motif-decisions/v1`; recipe `command_recovery/v1`; quality policy
`recovery/v1`. Identical input/action/outcome examples are deduplicated. Whole
sessions and identical decision inputs are grouped together before splitting.
Groups are sorted by deterministic hash, with approximately 20% held out. This
is not a chronological or cross-project generalization benchmark. At least two
independent groups are needed to evaluate; a single-group export is still useful
for inspection but cannot produce a held-out score.

The canonical JSON and its hash detect accidental mismatches, not maliciously
forged datasets. Validation also rejects duplicate IDs and related examples split
across groups. Never supply the full examples file as inference input: use the
blind test inputs.

## Bring your own model

Train or adapt outside Motif using `train.jsonl`. Give your model only the `input`
from each row of `test-inputs.jsonl`. Return a JSON file shaped as follows:

```json
{
  "datasetHash": "copy-the-manifest-hash",
  "predictions": [
    { "id": "example-id", "choice": "retry_unchanged" },
    { "id": "another-example-id", "abstain": true }
  ]
}
```

```sh
motif eval ./recovery-dataset --predictions ./predictions.json --json
```

The evaluator checks dataset identity, unknown and duplicate IDs, choice validity,
and split integrity. It reports agreement, selective agreement, macro-F1, coverage,
missing/invalid predictions, abstentions, per-choice counts and observed outcome
distributions. Missing, invalid and abstained predictions reduce overall agreement.
The majority baseline is fitted only on training labels.

These metrics measure imitation of recorded behavior. They cannot estimate what
would have happened under an unchosen action or establish causal improvement.
No propensity scores, counterfactual outcomes, or objective optimal-choice labels
are available in this first slice. Fine-tuning infrastructure, live routing,
`motif adapt`, and `motif.decide` are intentionally not implemented.

## Storage and API

Migration v15 adds `decision_events`, `decision_evidence`, and a small
`decision_scans` revision/coverage cache. Message mutations advance the session's
experience revision. Learning uses raw normalized messages; the lossy memory
digest and the presentation graph are never training-data sources. Existing
memory notes and human review records remain authoritative.

The new routes require a member token:

```text
GET  /api/decisions?scope=team&project=/workspace/app
GET  /api/decisions/:id?scope=team
POST /api/decisions/extract
POST /api/datasets/export
```

POST bodies accept `scope` (`team` or `personal`), optional `project`, and optional
`category` (`command_recovery`). Export returns the canonical dataset object;
the CLI writes its files. Unknown categories and invalid scopes fail explicitly.
Existing HTTP routes and all six MCP tools keep their existing contracts.

Future recipes can add explicit choice logging, richer state, test receipts and
action-level human labels. They should reuse this provenance and dataset contract
without treating session-level confidence as model confidence or causal evidence.
