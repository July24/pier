#!/usr/bin/env node
/**
 * Herdr hook (workspace.created / pane.created): register the Pier sidebar agent view (agent.view.set).
 * Strictly best-effort: any socket/API error exits silently so herdr workflows are never disrupted.
 */
import { request } from './herdr-rpc.mjs';
import { buildAgentViewSetParams } from '../src/agent-view.ts';

const params = buildAgentViewSetParams();

if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify(params, null, 2));
  process.exit(0);
}

if (!process.env.HERDR_SOCKET_PATH) process.exit(0);

request('agent.view.set', params, 3000)
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
