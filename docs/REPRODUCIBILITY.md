# Reproducibility Notes

## Dataset

`data/` contains a synthetic manufacturing dataset covering production orders, quality inspections, machines, downtime events, energy readings, inventory transactions and supplier receipts. The SQLite database and tabular files represent the same demonstration scenario and contain no real enterprise records.

## Experimental units

The formal task set contains 24 paired questions:

- E01–E08: external-retrieval tasks;
- I01–I08: internal-data tasks;
- H01–H08: hybrid tasks combining internal and external evidence.

Each question was independently executed three times for the closed-book baseline, fixed-context baseline and tool-augmented agent, producing 216 answers. Questions, acceptance rules and expected deliverables are stored in `experiments/comparison_questions.jsonl`.

## Released results

`experiments/final_results/` contains the recorded formal run:

- `raw_results.jsonl`: complete outputs, timing, token usage and tool traces;
- `blind_answers.jsonl`: anonymized A/B/C answers;
- `blind_key.jsonl`: mapping between anonymous positions and groups;
- `ratings_template.csv`: blank single-evaluator rating template;
- `paper_reported_metrics.csv`: aggregate metrics reported in the paper;
- `tool_evidence.jsonl`: compact tool evidence;
- `evidence_audit_report.md`: evidence and provenance audit;
- `efficiency_audit_report.md`: execution-efficiency audit;
- `manifest.json`: runtime configuration without API keys.

## Reproduction limits

External search results may change because of index updates, ranking changes and content removal. Model providers may also update the model behind an API alias. Consequently, exact text reproduction is not guaranteed; comparisons should focus on the published task contracts, objective acceptance checks and aggregate metrics.

The complete row-level manual rating sheet is not included in this initial release. The repository therefore distinguishes the released objective execution records from the aggregate subjective scores reported in the paper. A complete row-level sheet should be added before claiming that every subjective aggregate can be independently recomputed from this repository alone.


