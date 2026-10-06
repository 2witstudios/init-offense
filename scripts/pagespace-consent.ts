/**
 * What of `pagespace keys create --show-token`'s stderr reaches the user.
 * The token itself is the one stdout line; stderr carries the consent
 * flow (the browser is opening, or a URL to open by hand when it cannot,
 * or a device code) and then, once the key exists, a summary and MCP
 * client wiring tips that do not apply to a key a script holds. Until the
 * key is created, consent lines are forwarded as they arrive; everything
 * else is held back and shown only if the command fails, so its reason is
 * never lost. A token-shaped line is never forwarded.
 */

/** The CLI's success line; consent is over once it appears. */
const CREATED = /^Created key\b/;
const CONSENT =
  /https?:\/\/|\bbrowser\b|\bapprov|\bcode\b|\berror\b|\bfail|\bdenied\b|\btimed out\b|\bcancel|\bcould not\b|\bexpired\b/i;
const TOKEN = /\bmcp_[A-Za-z0-9_-]{8,}/;

/** True for a line the user needs while the CLI waits for consent. */
export function isConsentLine(line: string): boolean {
  return CONSENT.test(line) && !TOKEN.test(line);
}

export type ConsentFilter = {
  /** A chunk of stderr, split into lines as they complete. */
  readonly push: (chunk: string) => void;
  /** The exit code: on failure, the held-back lines are shown too. */
  readonly end: (code: number) => void;
};

export function consentFilter(write: (line: string) => void): ConsentFilter {
  let partial = '';
  let created = false;
  const held: string[] = [];
  const take = (line: string) => {
    if (TOKEN.test(line) || line.trim() === '') return;
    if (CREATED.test(line)) created = true;
    if (!created && isConsentLine(line)) write(line);
    else held.push(line);
  };
  return {
    push: (chunk) => {
      const lines = (partial + chunk).split(/\r?\n/);
      partial = lines.pop() ?? '';
      lines.forEach(take);
    },
    end: (code) => {
      if (partial !== '') take(partial);
      partial = '';
      if (code !== 0) held.splice(0).forEach(write);
    },
  };
}
