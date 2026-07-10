# deterministic per-agent randomness

from __future__ import annotations

import random
from typing import Sequence, TypeVar

T = TypeVar("T")


class ChaosRandom:
    # deterministic RNG for one agent's chaos decisions

    def __init__(self, seed: int, agent_id: int) -> None:
        self._rng = random.Random(seed + agent_id)

    def should_fire(self, probability: float) -> bool:
        # draw one decision
        return self._rng.random() < probability

    def uniform(self, low: float, high: float) -> float:
        return self._rng.uniform(low, high)

    def choice(self, options: Sequence[T]) -> T:
        return self._rng.choice(options)


def seeded_rng(seed: int, agent_id: int) -> ChaosRandom:
    # factory for the per-agent deterministic RNG
    return ChaosRandom(seed, agent_id)
