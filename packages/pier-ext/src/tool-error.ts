/**
 * pi only marks a tool result as failed when `execute()` throws; returning a value never sets the
 * error flag (pi docs/extensions.md, "Signaling errors"). Every hard failure goes through
 * `toolError()`, while deliberate non-failures (empty result set, "no match within Xms", a pane that
 * has not produced output yet) stay normal results.
 *
 * The leading "Error: " text is stripped: the provider's tool-result error channel and pi's red
 * rendering already mark it, and keeping it would double the prefix once pi formats a thrown error.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(String(message).replace(/^Error:\s*/, ''));
    this.name = 'ToolError';
  }
}

export function toolError(message: string): never {
  throw new ToolError(message);
}
