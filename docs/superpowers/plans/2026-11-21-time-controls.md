# Temporal controls for Codex Monitor

User requested parity with Claude Monitor and a push to both repositories.

Port daily/1/3/8/12-hour granularities, inclusive local date filters defaulting to today and two previous days, and optional local day08–20/night20–08 background bands. Preserve Codex-specific usage splitting, fork deduplication, reasoning prices, root/subagent/review grouping and account limits. Upgrade cx1 cache to zone-aware cx2 so hourly summaries regenerate once. Keep Claude cache entries intact when monitors share an origin.

Verification: Node test runner using the real inline application and controlled Codex transcript fixtures, alongside UI chart contract tests. All 16 tests failed on the original daily-only version before adaptation.

No dependencies or server changes.
