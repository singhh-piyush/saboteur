"""Deterministic per-agent randomness (CLAUDE.md invariant #1).

Every probabilistic decision in the chaos package flows through a
:class:`ChaosRandom` seeded with ``profile.seed + agent_id``. This is the
only place in the package where ``random.Random`` is instantiated; there
is no other randomness source (no ``random.random()``, nothing
time-based, nothing dependent on cross-agent ordering). Same profile +
seed + agent_id ⇒ identical fault sequence for an identical tool-call
sequence.
"""

from __future__ import annotations

import random
from typing import Sequence, TypeVar

T = TypeVar("T")


class ChaosRandom:
    """Deterministic RNG for one agent's chaos decisions."""

    def __init__(self, seed: int, agent_id: int) -> None:
        self._rng = random.Random(seed + agent_id)

    def should_fire(self, probability: float) -> bool:
        """Draw one fire/no-fire decision. Always consumes exactly one draw."""
        return self._rng.random() < probability

    def uniform(self, low: float, high: float) -> float:
        return self._rng.uniform(low, high)

    def choice(self, options: Sequence[T]) -> T:
        return self._rng.choice(options)


def seeded_rng(seed: int, agent_id: int) -> ChaosRandom:
    """Factory for the per-agent deterministic RNG."""
    return ChaosRandom(seed, agent_id)
