"""Persistence layer — a SQLite *index/cache* over the run artifacts.

Invariant #3 governs this package: ``runs/*.jsonl`` (and the ``*.scorecard.json``
derived from them) are the **source of truth**; the SQLite DB is only an index.
Everything here is reconstructable from those files alone — drop the DB, restart,
and it rebuilds (see :func:`saboteur.storage.db.backfill`). Scoring and replay
never read from the DB, so invariant #3 (live == replay) is unaffected.
"""
