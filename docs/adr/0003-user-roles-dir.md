# 0003. User roles stay under `~/.pi`

**Why:** `platformPaths.agentDataDir` follows XDG on Linux. Moving `userRolesDir` there would strand existing `~/.pi/agent/herdr-pi/roles` files without a migration.

**Decision:** keep `join(homedir(), '.pi', 'agent', 'herdr-pi', 'roles')`. Workspace roles remain `<cwd>/.pi-herdr/roles`.

**Rejected:** switching to XDG without a dual-read migration.
