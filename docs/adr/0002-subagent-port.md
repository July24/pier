# 0002. Atomic SubagentPort

**Why:** index passed a bag of independently-nullable callbacks that the plugin mutated field-by-field. A missing bag crashed at mount (`Cannot set properties of undefined (setting 'applyReplySession')`).

**Decision:** bind one `port.current` object at plugin mount and clear it on dispose. Index and the pipe handler optional-chain `current`.

**Rejected:** reverse field-by-field slots; cordis events for query-style calls (apply session, list running).
