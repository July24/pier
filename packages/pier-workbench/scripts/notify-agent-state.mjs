#!/usr/bin/env node
/**
 * Herdr hook (pane.agent_status_changed): toast notification when a pi subagent is blocked.
 * Herdr injects HERDR_PLUGIN_EVENT_JSON + HERDR_SOCKET_PATH; one-shot, no daemon footprint.
 */
import { request } from './herdr-rpc.mjs';
import { buildNotificationParams } from '../src/notify.ts';

const rawEvent = process.env.HERDR_PLUGIN_EVENT_JSON;
if (!rawEvent) process.exit(0); // No payload (link validation / manual dry-run): exit silently.

let event;
try {
  event = JSON.parse(rawEvent);
} catch {
  process.exit(0);
}

const params = buildNotificationParams(event);
if (!params) process.exit(0); // Gated out (not pi, not blocked, malformed).
if (!process.env.HERDR_SOCKET_PATH) process.exit(2);

request('notification.show', params, 5000).catch(() => process.exit(1));
