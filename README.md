# Saboteur

Chaos testing for AI agents.

## What is this?

AI agents look great in demos. In production, things break. APIs return errors, rate limits kick in, responses come back broken, and context gets lost. Many agents cannot handle this. They get stuck in retry loops, make up fake results, or quietly give up.

Right now there is no standard way to test how an agent handles failure before you ship it. Saboteur fixes that.

Saboteur runs your agent and breaks things on purpose. It injects faults like API errors, rate limits, slow responses, corrupted data, and lost memory, then watches what the agent does. Does it retry? Back off? Find another way? Or does it crash?

Think of it as a Chaos Monkey, but for AI agents.

## How it works

1. You pick a chaos profile: a named, seeded set of faults. Same seed means the same faults every time, so runs can be repeated and compared.
2. Saboteur spawns many identical agents at once and gives them all the same task while the faults hit them.
3. A live dashboard shows every agent in a grid: who is healthy, who is recovering, who crashed, and who finished.
4. At the end you get a Resilience Scorecard: survival rate, recovery time, wasted tokens, and a breakdown of how each agent failed or recovered.

## The fault types

- API errors (500s and 503s)
- Rate limits (429 with Retry-After)
- Timeouts and slow responses
- Malformed tool output
- Silent lies: tool output that looks correct but is wrong
- Context drops: the agent loses part of its memory
- Vanishing tools: a tool disappears in the middle of a run

## Built with

- smolagents for the agent loop
- FastAPI and Python asyncio for the orchestrator
- React, Vite, and Tailwind for the dashboard
- vLLM on ROCm with an AMD Instinct MI300X for running 50 agents at the same time
- llama.cpp for local development

Built for the AMD Developer Hackathon: ACT II.

## Status

Early. The repo is being set up. Code, setup steps, and a demo are coming.
