
export interface FaultStyle {
  /** chip text + glow color */
  color: string;
  /** short human layer label */
  layer: "tool" | "transport" | "context";
  /** one-line explanation shown in tooltips */
  description: string;
}

export const FAULT_STYLES: Record<string, FaultStyle> = {
  api_error:    { color: "#f4504a", layer: "tool",      description: "Simulated HTTP 500 on a tool call - agent must retry" },
  rate_limit:   { color: "#f5b73d", layer: "tool",      description: "HTTP 429 with Retry-After header - throttles the agent" },
  malformed:    { color: "#ff8a3d", layer: "tool",      description: "Garbled JSON response - agent must detect and recover" },
  silent_lie:   { color: "#e879b9", layer: "tool",      description: "Well-formed but wrong data - tests deception detection" },
  tool_vanish:  { color: "#a3adc2", layer: "tool",      description: "Tool disappears mid-run - agent must use a fallback" },
  latency:      { color: "#6aa9ff", layer: "transport", description: "Injected artificial delay before a tool call" },
  timeout:      { color: "#8c7bff", layer: "transport", description: "Call times out - agent must retry or replan" },
  context_drop: { color: "#3fd6c0", layer: "context",   description: "Last N steps removed from agent memory between turns" },
};

export function faultStyle(fault: string): FaultStyle {
  return FAULT_STYLES[fault] ?? { color: "#a3adc2", layer: "tool" };
}
