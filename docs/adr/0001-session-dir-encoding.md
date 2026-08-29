# 0001. Collision-resistant session directory names

**Why:** flattening `/` and `:` to `-` made `a/b` and `a-b` share one history/session directory. That silently merged unrelated workspaces.

**Decision:** encode `%`, `\`, `/`, `:` (`a/b` → `--a%2Fb--`). Reads try the new name first, then the legacy flattened name. Writes stay on an existing legacy directory so a ledger is not split.

**Rejected:** a silent rename (orphans on-disk history); hashing the path (not reversible, harder to debug).
