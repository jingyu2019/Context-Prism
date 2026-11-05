# SQLite backend

The SQLite backend stores the searchable text in a shadow column so the FTS5 index can be rebuilt without re-reading chunk content.

FTS5 reports relevance as a tiny negative rank, for example minus two point four times ten to the minus six for a perfect hit. The normalizer multiplies by one million to spread that band before mapping it into zero to one.

A migration adds the shadow column to a database created by an older version. Rows that predate the column are backfilled from the content column during the migration.

Both backends expose the same diagnostics shape: FTS error count, LIKE fallback count and the migration status, so the report never needs a per-backend conditional.
