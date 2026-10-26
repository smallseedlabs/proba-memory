# Evaluation harness

`apps/memory-eval` answers one question: **did a change to scoring (or to the write path) make retrieval better or
worse?** It replays a labelled corpus through the real write path, asks labelled questions through the real
retrieval service, and measures the answers. Everything runs in process on the hash embedder and the scripted
LLM: no network, no model call, same result every time (latency aside).

```
golden set (YAML/JSON)                        scoring profiles (data)
  observations (the corpus)  ──replay──►  write path ─► in-memory store + vector index
  queries + expected memories ──ask────►  retrieval service (one per profile)
                                                │
                    metrics ◄───────────────────┘   recall@k, precision@k, nDCG@k, MRR, avoid rate,
                       │                            token-pack size, latency
        ┌──────────────┼───────────────┬──────────────────┐
     report.json    report.md     regression gate     shadow-log reader
```

Commands (`npm run eval -- <command>`, which builds first; `node apps/memory-eval/dist/cli.js` after a build):

| Command | What it does |
| --- | --- |
| `validate --golden=<file>` | Check a golden set and print what it holds. |
| `run --golden=<file> --profile=default --profile=<file>` | Score profiles side by side; the first is the baseline. |
| `backtest ... --split=<ISO>` | The same, time-split (below). |
| `gate --config=<file>` | Run and compare with the stored baseline; exit non-zero on a regression. |
| `baseline --config=<file>` | Run and write the baseline file. |
| `shadow ...` | Score what a shadow profile would have returned (below). |

`npm run eval -- help` lists every option. Exit codes: `0` ok, `1` regression, `2` invalid input, `3` stale or
incomplete baseline.

## Golden sets

A golden set is a YAML or JSON file with the corpus and the questions. The bundled one is
[`apps/memory-eval/golden/bundled.yaml`](../apps/memory-eval/golden/bundled.yaml); copy it as a template.

```yaml
version: 1
name: my-set                       # letters, digits, . _ -
workspace: eval-workspace          # every observation and query belongs to it (override per item to test isolation)
now: 2026-10-25T09:00:00Z          # default time of the queries (default: the last observation)
k: [1, 3, 5]                       # cut-offs of the @k metrics; the last one is the headline k

observations:                      # the corpus, replayed through the write path in time order
  - key: budget-old                # unique; expectations refer to it
    occurredAt: 2026-09-02T10:00:00Z   # UTC, with the Z
    kind: thread.message           # default; approval.rejected, goal.created, ...
    text: "Monthly marketing budget is 10000 dollars."
    polarity: neutral              # positive | negative | neutral (the signal the resolver and extractor see)
    extract:                       # what the scripted model "extracts": exact wording, category, importance
      { category: semantic, content: "The monthly marketing budget is capped at 10000 dollars.",
        importance: 0.8, confidence: 0.8 }

queries:
  - id: current-budget
    query: "what is the monthly marketing budget"
    asOf: 2026-10-25T09:00:00Z     # optional
    limit: 5                       # optional, default: the largest k
    expect:
      observations: [budget-new]   # memories built from these observations are the right answer
      facts: ["20000 dollars"]     # and/or: the memory text contains this (case and spacing ignored)
      memoryIds: ["<uuid>"]        # and/or: a known memory id (stores whose ids you control)
      avoid:                       # must NOT be in the top k: an outdated or unwanted memory
        observations: [budget-old]
        facts: ["10000 dollars"]
```

How to add a case:

1. **Add the observation(s)** the answer comes from. Write `text` as a person would say it and `extract` as the
   memory you want the write path to store. Without `extract` the scripted provider's built-in rules write the
   memory (fine for a smoke test, but the wording is then not under your control). One observation per
   statement; two observations with the same text are rejected.
2. **Add the query** and point `expect` at the observation (preferred: it survives rewording) or at a `fact`.
3. **One expectation per distinct fact.** A memory satisfies one expectation. If a query needs two things, list
   two expectations; a memory that satisfies both claims the better-graded one.
4. **Grade when it matters.** `{ value: approval-rule, grade: 2 }` makes that expectation count double in nDCG
   (grades are 1..5, default 1). Recall counts expectations, not grades.
5. **Add `avoid` for stale or wrong answers.** This is what catches a profile that ranks an old fact above its
   replacement.
6. Run `npm run eval -- validate --golden=<file>`, then `run`, and read the per-query table: a query you expect to
   pass should show a first hit at rank 1 or 2. The corpus is tiny and the hash embedder is lexical (words and
   character trigrams, no meaning), so write queries that share words with the memory.
7. If the file is the one CI gates (`apps/memory-eval/golden/bundled.yaml`), update the baseline in the same
   commit: `npm run eval -- baseline --config apps/memory-eval/eval.config.yaml`. The gate refuses to compare
   against a baseline stored for a different golden set (exit 3), so a changed set cannot slip through unnoticed.

Notes:

- Observation expectations match on the source ref the write path stamps on a memory
  (`eval:<set>:<key>`). For a golden set aimed at a real deployment, whose refs you do not control, use `facts`
  or `memoryIds`.
- Never put secrets or real personal data into a golden set: it is committed, and the write path redacts them
  anyway, which would change the text you expect.
- Latency in a report is wall time of an in-process retrieval (the vector index and store are in memory). It
  shows relative cost between profiles, not production latency.

## Scoring profiles

A profile file lists only what differs from the built-in default profile; the result is validated with the same
schema the profile store uses (`parseScoringConfig`):

```yaml
name: recency-heavy
description: Recency weight 0.35 and shorter half-lives.
config:
  weights: { relevance: 0.4, recency: 0.35, importance: 0.1, confidence: 0.1, usefulness: 0.05 }
  halfLifeDays: { semantic: 30 }
```

`--profile=default`, `--profile=<file>`, `--profile=name=<file>` (rename). The first profile is the baseline;
`--baseline-profile=<name>` picks another. Names must be unique.

## Metrics

Computed per query, then averaged over the queries that have expectations (macro average). A cut-off `k` looks at
the first `k` returned memories.

| Metric | Meaning | Better |
| --- | --- | --- |
| `recall@k` | expectations satisfied in the top k ÷ expectations | higher |
| `precision@k` | relevant memories in the top k ÷ k (a query with one expectation tops out at 1/k: compare profiles, not the absolute value) | higher |
| `ndcg@k` | graded ranking quality, linear gain, 1.0 is the ideal order | higher |
| `mrr` | mean of 1 ÷ rank of the first relevant memory (0 when none) | higher |
| `avoidRate@k` | share of queries with an `avoid` list that returned something on it in the top k | lower |
| `tokens.mean`, `tokens.p95` | tokens of the packed result: what it costs to put it in a prompt | lower |
| `latencyMs.mean`, `latencyMs.p95` | wall time of one retrieval | lower, never judged |

A memory claims, from the top of the list down, the best-graded expectation it satisfies that no earlier memory
claimed. That keeps nDCG at or below 1. A second memory about an already claimed fact still counts as relevant
for precision and MRR but earns no gain.

## Time-split backtest

A static run replays the whole corpus and then asks every query. A **backtest** asks: *what would this profile
have answered at time T, knowing only what happened up to T?*

```bash
npm run eval -- backtest --golden=apps/memory-eval/golden/bundled.yaml \
  --profile=default --profile=apps/memory-eval/profiles/recency-heavy.yaml \
  --split=2026-09-18T00:00:00Z --split=2026-10-08T00:00:00Z [--horizon-days=14]
npm run eval -- backtest ... --rolling=2026-09-01T00:00:00Z,2026-10-20T00:00:00Z,7,7   # from,to,stepDays,horizonDays
```

Or in the config file (`windows:` with `replayUntil` and optional `queryUntil` and `name`, or `rolling:`).

For every window the harness builds an empty store, replays observations with `occurredAt <= T` (the clock is set
to each observation's time), then asks the queries whose `asOf` is after T (and at or before `queryUntil`, when
set) with the clock at the query's `asOf`. Nothing after T is ever written. Rules:

- An expectation that rests on an observation **after T** is left out for that window (listed as "not yet
  known"); a query with nothing left is skipped.
- `avoid` is enforced only when every expected observation is already known: it names what the expectation
  replaced, and before the replacement the old fact is the right one.
- Prefer observation expectations in a backtest. A `facts` expectation cannot be dated, so it is always held
  against the profile.
- A static run refuses a query whose explicit `asOf` is before the last observation (it would see the future);
  use a backtest.

The report shows the aggregate and one row per window (replayed observations, active and superseded memories,
asked and skipped queries, headline metrics per profile).

## Reading a report

`report.md` (and the same data in `report.json`, `schemaVersion: 1`) has these sections:

1. **Metrics**: one row per metric, one column per profile, and for each candidate the difference to the baseline
   with a verdict (`better`, `worse`, `same`; latency is `info`). Check the headline k first, then k = 1 (is the
   best answer on top?), then tokens.
2. **Time-split windows** (backtest only): `ndcg / recall` per profile and window. A profile that is good at the
   end but poor in the early windows struggles with a thin history.
3. **Query changes**: only the queries whose nDCG (then reciprocal rank) moved, with the rank of the first
   relevant memory before and after. **Read this before the averages**: on a small golden set one query is
   several points of nDCG, and a "worse" average can be a single reordered pair.
4. **Queries per profile**: first hit, recall, precision, nDCG, reciprocal rank, tokens and notes (`missed an
   expected memory`, `returned an avoided memory`, `target(s) not yet known`, `degraded: ...`).
5. **Profiles**: config digest of each profile, so you know exactly what was measured.

Typical readings: recall up and nDCG down means the right memory is found but lower in the list; `avoidRate`
down with nDCG flat means stale facts are pushed out at no cost; tokens up with nothing else moving means the
profile packs more for no benefit.

The numbers describe the golden set and the hash embedder. They tell you whether a change moved ranking on
cases you labelled; they do not predict production quality with a real embedder. Rerun interesting candidates
on a golden set written for your real data before promoting them.

## Regression gate

```bash
npm run build && npm run eval:gate          # = gate --config apps/memory-eval/eval.config.yaml --out-dir test-reports/eval
```

The gate runs the configured profiles on the golden set and compares them with the stored baseline
(`apps/memory-eval/golden/bundled.baseline.json`, committed, deterministic, no timestamps). It exits non-zero when,
for any profile in the baseline:

- a quality metric (`recall@k`, `precision@k`, `ndcg@k`, `mrr`) dropped by more than `tolerance` (absolute,
  default 0.02; `metricTolerance` overrides per metric),
- `avoidRate@k` rose by more than `avoidTolerance` (default 0),
- `tokens.mean` or `tokens.p95` grew by more than `tokensMaxIncrease` (relative, default 25 %),
- latency grew by more than `latencyMaxIncrease` and `latencyMinDeltaMs` (only when you set it: wall time is noisy;
  store latency in the baseline with `baseline --with-latency`),
- a metric of the baseline is missing from the run.

Exit codes: `1` regression, `3` the baseline does not fit the run (another golden set, changed golden content,
different `k`, mode or windows, or a profile without an entry); `--allow-stale` compares anyway. Improvements are
shown but never fail. A deliberate change of ranking: look at the table, then run `baseline` and commit the new
file with the change so the review shows exactly which numbers moved.

CI runs the gate in the `Retrieval Regression Gate` job on the bundled golden set, with the hash embedder and the
scripted LLM, and uploads `test-reports/eval/report.{md,json}`. The unit tests run the same comparison too.
Flags `--tolerance`, `--max-token-increase`, `--max-latency-increase` override the config for one run.

## Shadow and canary profiles

A scoring profile version moves `draft → shadow → canary → active → retired` (see ARCHITECTURE.md). A **shadow**
version is scored over the same candidates on every request and written to `retrieval_log.shadowResults`; it is
never returned. A **canary** version serves `canaryPercent` of requests, chosen by a hash of the trace id, and the
log records which version served each one (`profileVersion`, `profileServed`).

`shadow` reads those logs back and scores the served list and the shadow list with the same metrics against a
golden set:

```bash
# hermetic: serve the baseline, run the candidate as shadow in process, read the log back
npm run eval -- shadow --config apps/memory-eval/eval.config.yaml

# a deployment: read retrieval_log through the configured RetrievalLogStore and MemoryStore (read only)
DATABASE_URL=... npm run eval -- shadow --source=runtime --golden=my-golden.yaml --limit=2000

# an export: { "entries": [RetrievalLogEntry...], "memories": [{ "id", "workspaceId", "content", "sourceRefs" }] }
npm run eval -- shadow --golden=my-golden.yaml --logs=export.json
```

Logged queries are matched to golden queries by query hash (sha256 of the redacted, lower-cased query), within
the workspace; the newest log entry with a shadow list counts for each query. Shadow lists hold ids and scores
only, so the harness re-reads the memories to match them and re-counts their tokens (there is no latency for a
shadow list). For a golden set aimed at a live workspace use `facts` or `memoryIds` expectations. The report adds
agreement (`overlap@k` between the served and shadow top k, and how often both start with the same memory) and the
profile versions seen. Use it to decide whether a shadow version may become a canary: not worse on your golden
set, and the agreement is what you expect from the change.
