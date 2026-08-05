// Errors a tool can raise that the transports turn into JSON-RPC error
// objects rather than into a successful result containing bad news.
//
// The distinction matters for an agent: a *result* saying "blocked, here is
// why, here is what to change" is something to act on; an *error* means the
// call itself was not acceptable (unknown tool, quota exceeded) and must not
// be retried in a tight loop. Guard-rail refusals are results. Only the two
// cases below are errors.

export class ToolCallError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = 'ToolCallError';
  }
}

/** JSON-RPC application code for "you are calling too often". */
export const RATE_LIMITED_CODE = -32005;
