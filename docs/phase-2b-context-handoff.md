# Phase 2B Context Handoff

This document explains, in concrete terms, what was done in and after Phase 2B, why it was done, what worked, what failed, what was rolled back, and what state the codebase is in right now.

It is written so someone new to this thread can understand the work without having to reconstruct the entire conversation from eval outputs and scattered code changes.

## Executive Summary

Phase 2B started as an attempt to improve definition precision, especially on external repos like `tRPC`, without hurting BaseMemory.

The work naturally split into three layers:

1. Observability and analysis
2. Experimental identifier-risk policy work
3. Safer offline-only implementation-ranking simulation

The key outcome is:

- We now have much better observability and debugging tooling for retrieval failures.
- We proved that broad identifier suppression is too risky to ship.
- We restored the safer live behavior.
- We built a more targeted offline framework for the next definition-ranking iteration.

The current recommendation is:

- Keep live scoring behavior as-is
- Use the new offline tools to design a narrower implementation-seeking definition policy before any further production ranking changes

## What Phase 2B Was Trying To Solve

The main problem behind Phase 2B was this:

- Internal BaseMemory metrics could be made to look acceptable
- But external repos, especially `tRPC`, exposed failure modes where the wrong symbol or wrong chunk type outranked the true implementation

The recurring external failure patterns were:

- generic identifier matches outranking real implementations
- interface/type/module/export-wrapper chunks outranking implementation chunks
- wrong implementation chunks outranking the correct implementation chunk
- some relationship queries behaving like definition queries and getting caught in the wrong policy bucket

The big design constraint throughout Phase 2B was:

- no quality regressions on BaseMemory
- no broad heuristic changes without proof
- prefer offline analysis/simulation before production ranking changes

## Important Files Added or Changed

### Core ranking / config files

- [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts)
- [src/config/schema.ts](/Users/onlyaady/Desktop/BaseMemory/src/config/schema.ts)

### Analysis / simulation scripts

- [scripts/analyze-identifier-lane.ts](/Users/onlyaady/Desktop/BaseMemory/scripts/analyze-identifier-lane.ts)
- [scripts/simulate-identifier-policy.ts](/Users/onlyaady/Desktop/BaseMemory/scripts/simulate-identifier-policy.ts)
- [scripts/analyze-definition-implementation-failures.ts](/Users/onlyaady/Desktop/BaseMemory/scripts/analyze-definition-implementation-failures.ts)
- [scripts/simulate-definition-implementation-policy.ts](/Users/onlyaady/Desktop/BaseMemory/scripts/simulate-definition-implementation-policy.ts)
- [scripts/compare-eval-artifacts.ts](/Users/onlyaady/Desktop/BaseMemory/scripts/compare-eval-artifacts.ts)

### New shared offline policy module

- [src/indexer/definition-implementation-policy.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/definition-implementation-policy.ts)

### Tests

- [tests/config.test.ts](/Users/onlyaady/Desktop/BaseMemory/tests/config.test.ts)
- [tests/retrieval-ranking.test.ts](/Users/onlyaady/Desktop/BaseMemory/tests/retrieval-ranking.test.ts)
- [tests/definition-implementation-policy.test.ts](/Users/onlyaady/Desktop/BaseMemory/tests/definition-implementation-policy.test.ts)

### Local experimental config

- `.opencode/basememory-risk-policy-config.json`

This file is local-only and was used to test the experimental identifier-risk policy behind a config flag.

## Phase 2B, Step By Step

### 1. Score observability groundwork was already in place

Before the later Phase 2B experiments, the project already had `scoreBreakdown` instrumentation added to search results and eval artifacts.

This mattered because it let us answer questions like:

- what lane promoted this result
- what scoring stages fired
- whether reranker helped or hurt
- whether a rank-1 result won because of identifier promotion, graph promotion, path penalties, or reranker replacement

Without that layer, the rest of Phase 2B would have been guesswork.

## 2. Experimental identifier risk policy was introduced

An opt-in config flag was added:

- `search.experimentalIdentifierRiskPolicy`

This lives in [src/config/schema.ts](/Users/onlyaady/Desktop/BaseMemory/src/config/schema.ts).

The flag default is `false`.

The intended scope was narrow:

- definition task only
- source-seeking intent only
- no relationship queries
- no test/debug queries
- no config queries

The main production code for this sits in [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts).

The key exported helpers added during this work were:

- `classifyIdentifierQuality(...)`
- `shouldApplyExperimentalIdentifierRiskPolicy(...)`
- `applyConservativeIdentifierRiskPolicyToSetScore(...)`
- `applyConservativeIdentifierRiskPolicyToAddScore(...)`

### Identifier quality labels

The system began labeling identifier promotions with categories such as:

- `exact-symbol`
- `alias-symbol`
- `file-anchored-symbol`
- `compound-symbol`
- `weak-substring`
- `path-only`
- `type-only`

These labels were recorded in score breakdown reasons so they could be analyzed offline.

## 3. Identifier-lane analysis tooling was built

[scripts/analyze-identifier-lane.ts](/Users/onlyaady/Desktop/BaseMemory/scripts/analyze-identifier-lane.ts) was built to inspect eval artifacts and answer questions like:

- which identifier-promoted results displaced the expected answer
- what score floors or boosts were used
- what quality labels they had
- whether they matched the expected file
- whether they matched the expected symbol

This script was used to understand not just that a query failed, but what kind of identifier evidence caused the failure.

## 4. Identifier policy simulator was built

[scripts/simulate-identifier-policy.ts](/Users/onlyaady/Desktop/BaseMemory/scripts/simulate-identifier-policy.ts) was added as a read-only replay tool.

Its purpose:

- take an existing eval artifact
- replay hypothetical identifier-risk policies offline
- estimate what would improve
- estimate what would regress
- do this without changing production ranking

The simulator supported ideas like:

- protecting current Hit@1 queries
- only simulating risky definition queries
- comparing expected-rank improvements vs regressions

This simulator was a major quality gate improvement because it let us reject risky ideas before they reached production.

## 5. Compound identifier specificity diagnostics were added

One repeated failure mode on `tRPC` was that multiple broad domain terms were being treated as meaningful compound signal.

Examples:

- `trpc + error`
- `request + handler`
- `trpc + builder`

These are often generic repo/domain vocabulary, not precise symbol evidence.

To expose that, [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts) was extended with:

- `CompoundIdentifierSpecificity`
- `classifyCompoundIdentifierSpecificity(...)`
- `getCompoundIdentifierSpecificity(...)`

These produced artifact annotations like:

- `strong-compound`
- `generic-compound`
- `mixed-compound`

And the score breakdown reasons gained fields like:

- `compoundSpecificity=...`
- `compoundGenericHints=...`
- `compoundSpecificHints=...`

This was one of the most valuable observability improvements of the whole phase.

## 6. First production experiment: generic-compound suppression

Once `generic-compound` was visible, the next experiment was:

- treat `generic-compound` like a risky identifier quality
- apply the same conservative score caps used for weak substring matches

This was implemented in live ranking code in [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts), still behind the experimental flag.

The idea sounded promising because:

- it directly targeted cases like `trpc-def-transform-wire-result`
- it did not penalize `mixed-compound` or strong exact matches

### What happened in evals

This experiment did not hold up.

It helped some queries, but it created new problems:

- `trpc-rel-node-http-resolve` regressed
- some rank-1 winners churned from one wrong result to another wrong result
- it changed prererank candidate pools in unstable ways

The critical insight from that failure:

- broad generic-compound demotion is still too blunt
- relationship-style queries and some implementation queries can both contain generic compound evidence, but not for the same reasons

### Result

The live `generic-compound` scoring behavior was rolled back.

The diagnostics were kept.

This is important:

- the observability remains
- the risky production behavior does not

## 7. Stable live behavior was restored

After the rollback, live retrieval behavior returned to the safer experimental baseline.

Specifically:

- the harmful new regression introduced by generic-compound suppression disappeared
- but the original experimental identifier-risk flag still was not comparator-clean on `tRPC`

So the stable outcome was:

- keep the diagnostics
- stop expanding broad identifier suppression
- move to a narrower policy family

## 8. Quality-aware artifact comparison was improved

[scripts/compare-eval-artifacts.ts](/Users/onlyaady/Desktop/BaseMemory/scripts/compare-eval-artifacts.ts) became an important part of the gating strategy.

It now has a quality mode intended to fail only on real retrieval-quality regressions, rather than raw score drift alone.

This tool became the acceptance gate for:

- internal stability checks
- flag off/on comparisons
- refactor safety checks

It helped distinguish:

- harmless reranker jitter
- candidate-pool churn
- actual hit/expected-rank regressions

## 9. New definition-failure classifier was built

After the broad identifier path proved too risky, the focus shifted to a more specific question:

- for implementation-seeking definition queries, what kind of wrong thing is actually winning rank 1?

To answer that, [scripts/analyze-definition-implementation-failures.ts](/Users/onlyaady/Desktop/BaseMemory/scripts/analyze-definition-implementation-failures.ts) was built.

This script analyzes definition failures and classifies rank-1 winners into categories like:

- `wrapper-export`
- `options-shape`
- `type-interface`
- `module`
- `wrong-implementation`
- `test`
- `doc`

It also reports:

- whether the expected chunk is indexed at all
- whether it appears in top 10
- whether reranker helped, hurt, or was not observable
- what lane the winner came from

### What this classifier revealed on tRPC

On the analyzed `tRPC` artifact:

- all 7 definition failures had the expected chunk indexed
- 5 of 7 expected chunks were not in top 10
- rank-1 winner categories were:
  - `wrong-implementation`: 5
  - `type-interface`: 1
  - `wrapper-export`: 1
- rank-1 winner lane was mostly `identifier`: 6 of 7
- one failure was graph-driven: `trpc-def-observable-factory`

This was a crucial turning point.

It showed that the next best policy is not “more identifier suppression.”

It is:

- implementation-vs-shape/wrapper ranking for definition queries

## 10. Shared offline implementation policy module was added

[src/indexer/definition-implementation-policy.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/definition-implementation-policy.ts) was added as a shared, non-production policy helper module.

It contains:

- `classifyDefinitionWinnerCategory(...)`
- `isImplementationSeekingDefinitionQuery(...)`
- `hasExactSymbolEvidence(...)`
- `getDefinitionImplementationPenalty(...)`
- `getDefinitionImplementationBonus(...)`

The conservative offline policy currently models:

- wrapper export penalty
- options-shape penalty
- type/interface penalty
- module penalty
- implementation bonus
- same-file implementation bonus

Important:

- this is not live ranking code
- it is an offline modeling layer used by scripts

## 11. Offline definition-implementation simulator was built

[scripts/simulate-definition-implementation-policy.ts](/Users/onlyaady/Desktop/BaseMemory/scripts/simulate-definition-implementation-policy.ts) was added to replay a narrow definition-only policy offline.

The simulator currently models:

- penalties to:
  - `wrapper-export`
  - `options-shape`
  - `type-interface`
  - `module`
- bonuses to:
  - real implementation chunks
  - same-file implementations

This simulator is intentionally narrower than the identifier-policy simulator:

- definition task only
- definition query type only
- protect current Hit@1 by default
- no reranker re-execution
- no new candidates outside artifact top K

### Offline results so far

The policy is directionally promising but still too weak to justify production rollout.

At the latest checkpoint it showed:

- no current Hit@1 regressions
- no expected-rank regressions
- some improvement on `trpc-def-procedure-builder-factory`
- some rank-1 movement on `trpc-def-request-info-parser`
- overall still not enough improvement to justify live ranking changes

This is actually a good outcome:

- the simulator is proving ideas safely
- we are not pushing half-baked ranking changes into production

## What Was Explicitly Rolled Back

The key rollback after Phase 2B was:

- live `generic-compound` risk-policy scoring behavior

What was not rolled back:

- the ability to diagnose compound specificity
- the identifier-quality labeling
- the analysis scripts
- the simulators
- the test coverage around these concepts

This is the right tradeoff:

- keep the insight
- remove the risky behavior

## Current Live State

As of this handoff:

- live ranking includes the original experimental identifier-risk policy for:
  - `weak-substring`
  - `path-only`
  - `type-only`
- live ranking does **not** currently penalize `generic-compound`
- compound specificity is still recorded in diagnostics
- no new implementation-ranking behavior has been rolled out to live search
- all implementation-vs-shape/wrapper policy work is still offline-only

## Current Offline State

We now have a much stronger safety net than we had before Phase 2B:

- artifact comparator for quality-aware eval diffs
- identifier-lane analyzer
- identifier-policy simulator
- definition-failure classifier
- definition-implementation policy module
- definition-implementation simulator

These tools make future scoring work far less risky than earlier attempts.

## Tests Added / Expanded

### Identifier-risk / ranking tests

[tests/retrieval-ranking.test.ts](/Users/onlyaady/Desktop/BaseMemory/tests/retrieval-ranking.test.ts) now covers:

- identifier quality classification
- compound specificity classification
- conservative identifier risk set-score behavior
- conservative identifier risk additive behavior

### Config tests

[tests/config.test.ts](/Users/onlyaady/Desktop/BaseMemory/tests/config.test.ts) now covers:

- `experimentalIdentifierRiskPolicy` parsing and default behavior

### Offline implementation policy tests

[tests/definition-implementation-policy.test.ts](/Users/onlyaady/Desktop/BaseMemory/tests/definition-implementation-policy.test.ts) now covers:

- implementation-seeking definition query detection
- wrapper export classification
- options/type classification
- exact-symbol evidence protection
- penalty behavior for shape/wrapper winners
- implementation bonus behavior

## Commands That Matter Going Forward

### Typecheck

```bash
npm run typecheck
```

### Focused tests

```bash
npx vitest run tests/definition-implementation-policy.test.ts tests/retrieval-ranking.test.ts tests/config.test.ts
```

### Compare eval artifacts

```bash
npx tsx scripts/compare-eval-artifacts.ts <artifact-a> <artifact-b>
```

### Analyze identifier-lane behavior

```bash
npx tsx scripts/analyze-identifier-lane.ts <artifact-dir>
```

### Simulate identifier policy offline

```bash
npx tsx scripts/simulate-identifier-policy.ts <artifact-dir>
```

### Analyze definition implementation failures

```bash
npx tsx scripts/analyze-definition-implementation-failures.ts <artifact-dir>
```

### Simulate definition implementation policy offline

```bash
npx tsx scripts/simulate-definition-implementation-policy.ts <artifact-dir>
```

## What We Know For Sure Now

These are the strongest conclusions from the work so far:

1. Broad identifier suppression is too risky to ship.
2. `compoundSpecificity` was worth adding, because it exposed why some compound matches are generic noise.
3. The real hard external failures are mostly not missing-index failures.
   The expected chunk usually exists.
4. The main definition failure modes are:
   - wrong implementation
   - wrapper export
   - type/interface
5. Relationship queries must be kept out of future implementation-ranking experiments.
6. Offline simulation before production changes is the correct workflow for this project.

## Recommended Next Step

The next best move is:

- continue working offline first
- refine the implementation-ranking simulator, not the live engine

Specifically:

1. strengthen same-file implementation preference in the offline simulator
2. restrict implementation bonus to cases where the current competing winner is:
   - `wrapper-export`
   - `module`
   - `type-interface`
   - `options-shape`
3. do not apply implementation bonus broadly against other implementation chunks unless offline evidence proves it safe
4. replay against `tRPC`
5. only if offline results show:
   - multiple improvements
   - zero hit regressions
   - zero expected-rank regressions
   then move the narrowest winning rule behind the experimental flag

## Current Bottom Line

Phase 2B did not directly produce a production-ready ranking fix.

That is not failure.

It produced something more valuable:

- a much more precise understanding of the failure space
- a safer and more disciplined workflow
- several analysis and simulation tools that prevent reckless scoring changes

The project is now in a better position to make the next ranking change well, instead of making it quickly.
