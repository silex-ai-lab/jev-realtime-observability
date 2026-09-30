// Trace builders shared by the AP (scenarios.js) and SOC (scenarios-soc.js) scenario modules.
// A trace is a root span plus child spans; every span gets the defaults below.

export function traceFor(agent) {
  return function trace(id, scenario, title, spans) {
    return {
      trace_id: id, scenario, title,
      spans: spans.map((s, i) => ({
        trace_id: id,
        span_id: `${id}-s${i + 1}`,
        parent_span_id: i === 0 ? null : `${id}-s1`,
        agent,
        boundary: null,
        sources: [],
        tool: null, result: null, readback: null, text: null, context: {},
        age_ms: 120,
        label: null,
        scenario,
        ...s,
      })),
    };
  };
}

export const root = (name, text) => ({ kind: 'invoke_agent', name, text });
export const lbl = (expected, decided_by) => ({ expected, decided_by });
