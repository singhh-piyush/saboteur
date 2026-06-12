/** Display palette for the 8 fault types (CLAUDE.md fault taxonomy). */

export interface FaultStyle {
  /** Chip text + glow color. */
  color: string;
  /** Short human layer label. */
  layer: "tool" | "transport" | "context";
}

export const FAULT_STYLES: Record<string, FaultStyle> = {
  api_error: { color: "#f4504a", layer: "tool" },
  rate_limit: { color: "#f5b73d", layer: "tool" },
  malformed: { color: "#ff8a3d", layer: "tool" },
  silent_lie: { color: "#e879b9", layer: "tool" },
  tool_vanish: { color: "#a3adc2", layer: "tool" },
  latency: { color: "#6aa9ff", layer: "transport" },
  timeout: { color: "#8c7bff", layer: "transport" },
  context_drop: { color: "#3fd6c0", layer: "context" },
};

export function faultStyle(fault: string): FaultStyle {
  return FAULT_STYLES[fault] ?? { color: "#a3adc2", layer: "tool" };
}
