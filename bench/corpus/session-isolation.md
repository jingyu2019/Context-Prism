# Session isolation

History and trajectory chunks are session scoped: a chunk captured from session A is A's private memory, never project knowledge. Code, file and preference chunks are project scoped and visible to every session.

A session cursor chunk records how far a session has been captured. It is a control record: retrieval must never return it and no window may render it.

An imported JSONL corpus has no owning session. Unowned chunks are treated as project wide, so a shared benchmark corpus stays reachable from every session.

The retrieval cache key contains the normalized session scope next to the index revision. Array keys compared by identity always missed, so the cache never served anything until the key became a string.

Scope normalization rejects non-string values. A blank string or null means the whole index; anything else must be the exact session id that owns the chunk.
