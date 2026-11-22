// Turns any thrown value into one readable line. Node's fetch hides the real reason
// (ENOTFOUND, ECONNRESET, a certificate problem...) in `cause`, so it is brought forward.
export function explain(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const detail = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : '';
  return detail && !error.message.includes(detail) ? `${error.message} (${detail})` : error.message;
}
