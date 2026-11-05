# Evaluation

Recall at K is the fraction of gold chunks that appear in the top K of the ranked list, averaged over queries. A single-gold query scores one when the gold chunk is anywhere in the top K.

Mean reciprocal rank averages the reciprocal of the rank of the first gold chunk. A query whose gold chunk sits at rank four contributes zero point two five.

Normalized discounted cumulative gain uses binary relevance, because the labels mark set membership rather than a graded judgement. The ideal gain is the sum of the discount factors of the gold chunks.

Token efficiency divides the injected window tokens by the tokens of the gold chunks that actually appear in the window. Lower is better: a verbose window that buries the answer is expensive even when recall is perfect.

The no-injection baseline assembles no window at all. It must score zero recall and zero reciprocal rank; a harness that cannot reproduce that is measuring noise.
