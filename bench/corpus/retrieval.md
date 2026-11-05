# Retrieval scoring

BM25 ranks candidates with a term-frequency saturation constant k1 of 1.5 and a length-normalization parameter b of 0.75. Document frequency enters through the inverse document frequency term, so a token that appears in every chunk contributes almost nothing.

Semantic similarity is computed by cosine similarity between the query embedding and the chunk embedding. The embedding module hashes tokens and character bigrams into a fixed-size vector, so it rewards lexical overlap rather than learned meaning; it is a second opinion on the same tokens.

Recency decays exponentially with a half-life of seven days. A chunk captured today contributes the full recency weight; a chunk older than three half-lives contributes almost nothing.

A scoped search asks the backend for four times topK candidates, capped at topK plus two hundred. Filtering an unscoped ranked list instead would hide a session's own material whenever foreign chunks crowd the global topK.

The topK cutoff defaults to forty. Ties are broken by chunk id, because the in-memory and SQLite backends return candidates in different scan orders and an explicit tie-break makes their rankings comparable.
