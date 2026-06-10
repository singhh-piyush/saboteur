"""Agent factory, mock tools, task definition, and programmatic verifier.

Build step 2 — to be implemented after the chaos engine is in place.

Planned modules:
    factory     — create_agent(agent_id, profile) → smolagents ToolCallingAgent
    tools       — deterministic mock tools (get_weather, file_report, …)
    task        — task prompt + hardcoded ground truth
                  (Tokyo = 22.0 °C → 71.6 °F in a filed report)
    verifier    — programmatic success check over the filed report
"""
