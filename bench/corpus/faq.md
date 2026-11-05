# Frequently asked questions

Why does my context window feel empty? Check the Omitted Memory note first; it reports how much was dropped, and widening the budget is usually the fix.

Does the cache survive a restart? No. It is a bounded in-memory map with a time to live, so a new process starts cold.

Can another session read my captured history? Only if the scope is unset. The isolation rules keep private captures out of a foreign window.

What happens when two chunks have the same score? The ordering is deterministic, so the same input always produces the same list.

Which tokenizer is used for English prose? Words are lowercased ASCII runs, and punctuation is never part of a term.

How large is the report? It is JSON with counts and per-session rows. Chunk text and query text are deliberately absent.
