// Customer-facing error text. The server's validation messages ("... is sold out.", "Please select ...") are
// already written for customers and are passed through; transport/technical failures are replaced by plain language.
const TECHNICAL = /^(API error \d+|Failed to fetch|NetworkError|Load failed|Unexpected token|<!DOCTYPE|\{|Server returned)/i;

export function friendlyError(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  // Our own server failing (5xx): never show its text, whatever it says.
  if (typeof (error as any)?.status === 'number' && (error as any).status >= 500) return fallback;

  let message = '';
  if (error instanceof Error) message = error.message;
  else if (typeof error === 'string') message = error;
  message = (message || '').trim();

  // JSON error bodies that arrived as text
  if (message.startsWith('{')) {
    try {
      const parsed = JSON.parse(message);
      message = String(parsed.error || parsed.message || '').trim();
    } catch { message = ''; }
  }
  if (!message) return fallback;
  if (/429|too many/i.test(message)) return 'Too many requests. Please wait a moment and try again.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'We could not reach the server. Please check your connection and try again.';
  if (TECHNICAL.test(message) || message.length > 240) return fallback;
  return message;
}
