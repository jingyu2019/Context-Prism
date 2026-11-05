# Compression

The assembly budget is the maximum token count minus the reserved output tokens. A budget that is zero or negative is rejected before any work happens.

Each packed item costs its own tokens plus a two-token separator, so a section of five items pays eight separator tokens. Ignoring the separators let the assembled section overshoot the budget it was packed against.

When an item does not fit whole, the compressor tries a shorter extract built from the sentences that best match the query. If the remaining budget is too small for even that, the item is omitted.

Omitted items are summarized in a single note that reports the omitted count and the omitted token total, which is the only place the model learns that memory was dropped.

User preferences are always included: they are scored by the shared formula but never filtered out, so a preference with no query overlap simply sorts last.
