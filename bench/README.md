# Retrieval benchmark fixture

Committed, deterministic input for `engine/evaluation.js` (spec §7). Nothing here
is generated at test time: the corpus, the labels and the chunk ids are reviewed
like source, because a benchmark that quietly changes measures nothing.

## Layout

- `corpus/**` — 41 short markdown blocks across 8 files: retrieval scoring,
  session isolation, ingestion, compression, the SQLite backend, evaluation
  itself, operations and a FAQ of near-miss paragraphs.
- `queries.jsonl` — 41 labelled queries, one JSON object per line:
  `{"id":"q01","query":"…","goldChunkIds":["bench:retrieval.md#0"],"sessionId":null}`

## Chunk ids

`bench:<path relative to corpus>#<block>` — for example `bench:ingest.md#4` is the
fifth block of `bench/corpus/ingest.md`. Blocks are separated by blank lines and a
lone markdown heading is dropped, so the numbering starts at the first paragraph.
Ids never contain the working directory, so the labels survive a checkout move;
`loadBenchFixture()` assigns them, not `ingestFile()`.

## Query labels

Every query names the blocks that should be retrieved. Labels are semantic:
"should a reader accept this block as the answer to the question", not "does the
block contain these characters" — that is the whole point of replacing the old
substring check. A query may name more than one gold block when two blocks answer
it (`q36`).

The set deliberately mixes phrasing:

- Most queries reuse enough of a block's vocabulary that lexical retrieval should
  find it, with the gold block ranked 1st to 4th — that spread is what makes
  MRR and nDCG informative instead of pinned at 1.
- A few are natural user questions with distant vocabulary (`q40`, `q41`), where
  the two routes disagree about the correct block.
- `q39` ("a shortcut points back at its parent folder" → the symlink-cycle block)
  is intentionally far from the corpus wording. Lexical retrieval is expected to
  miss it, which is why `Recall@10` sits below 1.0: a benchmark where nothing is
  ever missed cannot detect a recall regression either.

Recorded baseline on the committed fixture, k = 10, `routes` in default order:

```
route         Recall@10   MRR     nDCG@10   tokenEfficiency
no-injection  0.000       0.000   0.000     null
bm25-only     0.9756      0.7852  0.8329    35.24
hybrid        0.9756      0.7575  0.8123    35.24
```

Read that as a measurement, not a verdict: on this fixture the hashed lexical
embedding does not improve ranking over pure BM25, and it costs nothing extra in
injected tokens. The evaluator exists so a claim like that can be checked instead
of asserted.

## The control

`no-injection` assembles no window at all, so it must report zeros and a `null`
token efficiency. If it ever reports a hit, the harness is leaking state between
routes and the other two rows are untrustworthy.
