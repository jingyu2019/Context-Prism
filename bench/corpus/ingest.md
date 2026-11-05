# Ingestion

Text is split into chunks of eight hundred characters with an overlap of eighty characters, so a sentence that straddles a boundary is still retrievable from both sides.

The directory walk enforces a maximum file size and a maximum total volume. Files above the size cap are skipped and counted under sizeSkipped instead of aborting the whole walk.

Symbolic links are not followed. A link cycle would otherwise make the walk non-terminating, so the walker records the link under symlinkSkipped and continues.

A .lceignore file lists glob patterns that the walk must skip, which keeps build output and vendored dependencies out of the index.

Chinese, Japanese and Korean text is tokenized into overlapping bigrams. A run of one character emits that single character, and ASCII runs still produce one lowercased token per word.

Incremental ingestion stores modification time and size per path. An unchanged file is skipped without re-reading or re-chunking it.
