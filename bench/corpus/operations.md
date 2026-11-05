# Operations

The storage path selects the persistence file. A one-shot local evaluation opens an in-memory index instead, so it never touches the user's saved store.

The retrieval cache and the compression cache expire after sixty seconds by default and hold one hundred and twenty-eight entries each.

The report schema has schema version one and reports counts by kind, counts by scope, per-session rows, injection settings, host information and search diagnostics.

The evaluator is a regression gate: it must finish in a few seconds on the committed corpus, otherwise nobody runs it before a release.

A benchmark query names its query text and the gold chunk ids it should retrieve. The ids are stable across working directories because they are derived from the corpus path and block index.
