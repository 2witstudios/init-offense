/**
 * Case-aware renaming of the template placeholder `acme` (pure, no I/O).
 *
 * Every occurrence of the placeholder, in any case, is replaced by the form
 * of the new project name that fits where it stands:
 *
 *   ACME                       → SCREAMING_SNAKE      (ACME_E2E_LOCK_DIR → WIDGET_APP_E2E_LOCK_DIR)
 *   Acme inside an identifier  → PascalCase           (AcmeMark → WidgetAppMark)
 *   Acme in prose              → display name         ("Sign in to Acme" → "Sign in to Widget App")
 *   acme before an uppercase   → camelCase            (holder.acmeWebApp → holder.widgetAppWebApp)
 *   acme next to `_`           → snake_case           (acme_web → widget_app_web)
 *   acme in a Postgres context → snake_case           (postgres://acme:pw@h/acme → …/widget_app)
 *   acme anywhere else         → the slug (kebab)     (@acme/web, acme-mark, x-acme-client-ip)
 *
 * The template repository (`2witstudios/acme`) is replaced verbatim by the
 * new repository before the placeholder pass so `--repo` wins over a
 * mechanical rename.
 */

const PLACEHOLDER = 'acme';

export type Names = {
  /** Lowercase kebab slug, e.g. `widget-app`. */
  readonly slug: string;
  /** Human display name, e.g. `Widget App`. Used only in prose. */
  readonly display: string;
  /** New `owner/name` repository; replaces `templateRepo` in text. */
  readonly repo?: string;
  /** The template's own repository string, e.g. `2witstudios/acme`. */
  readonly templateRepo?: string | undefined;
};

export type NameForms = {
  readonly kebab: string;
  readonly snake: string;
  readonly camel: string;
  readonly pascal: string;
  readonly screaming: string;
  readonly display: string;
};

// At most 30 characters: worktree slot databases are
// `<slug_snake>_wt_<id>_test_run_<8 hex>`, which must fit Postgres's
// 63-character identifier limit with room for a real slot id
// (scripts/slot-naming.ts); 30 leaves ids of up to 11 characters.
const SLUG = /^[a-z][a-z0-9-]{0,29}$/;
// Display names land inside single- and double-quoted strings, Markdown and
// HTML, so quotes, backslashes, angle brackets and backticks are refused.
const DISPLAY = /^[A-Za-z0-9][A-Za-z0-9 .&-]{0,62}$/;

/** Returns a problem description, or null when the slug is acceptable. */
export function slugProblem(slug: string): string | null {
  if (!SLUG.test(slug))
    return `must match ${SLUG} (lowercase letter first, then lowercase letters, digits or hyphens, at most 30 chars)`;
  if (slug.includes('--') || slug.endsWith('-'))
    return 'must not contain "--" or end with "-"';
  if (slug.toLowerCase().includes(PLACEHOLDER))
    return `must not contain the template placeholder "${PLACEHOLDER}"`;
  return null;
}

export function displayProblem(display: string): string | null {
  if (!DISPLAY.test(display))
    return `must match ${DISPLAY} (letters, digits, spaces, ".", "&", "-")`;
  if (display.toLowerCase().includes(PLACEHOLDER))
    return `must not contain the template placeholder "${PLACEHOLDER}"`;
  return null;
}

const words = (slug: string): string[] => slug.split('-').filter(Boolean);
const capitalize = (word: string): string =>
  word.charAt(0).toUpperCase() + word.slice(1);

/** Title-cased words of the slug: `widget-app` → `Widget App`. */
export const defaultDisplay = (slug: string): string =>
  words(slug).map(capitalize).join(' ');

export function nameForms(names: Names): NameForms {
  const parts = words(names.slug);
  const pascal = parts.map(capitalize).join('');
  return {
    kebab: names.slug,
    snake: parts.join('_'),
    camel: pascal.charAt(0).toLowerCase() + pascal.slice(1),
    pascal,
    screaming: parts.join('_').toUpperCase(),
    display: names.display,
  };
}

// Spans where a lowercase placeholder names a Postgres role or database,
// which must be a bare snake_case identifier.
const POSTGRES_CONTEXTS: readonly RegExp[] = [
  /postgres(?:ql)?:\/\/[^\s'"`<>)]*/g,
  /POSTGRES_(?:USER|DB|PASSWORD)\s*[:=][^\n]*/g,
  /pg_isready[^\n'"]*/g,
  /\b(?:database|role|owner to|grant)\s+acme\b/gi,
];

type Span = readonly [number, number];

const postgresSpans = (text: string): Span[] =>
  POSTGRES_CONTEXTS.flatMap((pattern) =>
    Array.from(text.matchAll(pattern), (match): Span => [
      match.index,
      match.index + match[0].length,
    ]),
  );

const inside = (spans: readonly Span[], index: number): boolean =>
  spans.some(([start, end]) => index >= start && index < end);

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * True when a capitalized `Acme` is part of an identifier, hostname or path
 * rather than a word of prose: glued to an identifier character, or to
 * `@`, `/`, `\`, `-`, or a `.` that continues into a name (`Acme.example.com`).
 */
const pascalContext = (text: string, start: number, end: number): boolean => {
  const before = text.charAt(start - 1);
  const after = text.charAt(end);
  if (IDENT_CHAR.test(before) || IDENT_CHAR.test(after)) return true;
  if (['@', '/', '\\', '-'].includes(before)) return true;
  if (before === '.' && IDENT_CHAR.test(text.charAt(start - 2))) return true;
  return after === '.' && /[A-Za-z0-9]/.test(text.charAt(end + 1));
};

/**
 * True when a capitalized `Acme` is a whole DNS label (`Player@Acme.example.com`,
 * `www.Acme.dev`). Hostnames are case-insensitive, so it must become a case
 * variant of the kebab slug (`Widget-app`), never `WidgetApp`, which names a
 * different host than the lowercase `widget-app` spelled elsewhere.
 */
const hostLabelContext = (
  text: string,
  start: number,
  end: number,
): boolean => {
  const before = text.charAt(start - 1);
  const after = text.charAt(end);
  if (IDENT_CHAR.test(before) || IDENT_CHAR.test(after)) return false;
  if (before === '@') return true;
  if (before === '.' && IDENT_CHAR.test(text.charAt(start - 2))) return true;
  return after === '.' && /[A-Za-z0-9]/.test(text.charAt(end + 1));
};

type Mode = { readonly path?: boolean };

/** The form of a capitalized `Acme`: PascalCase, a host label or prose. */
function capitalizedReplacement(
  text: string,
  start: number,
  forms: NameForms,
  mode: Mode,
): string {
  const end = start + PLACEHOLDER.length;
  if (mode.path) return forms.pascal;
  if (hostLabelContext(text, start, end)) return capitalize(forms.kebab);
  return pascalContext(text, start, end) ? forms.pascal : forms.display;
}

function replacement(
  text: string,
  start: number,
  matched: string,
  forms: NameForms,
  spans: readonly Span[],
  mode: Mode,
): string {
  const end = start + matched.length;
  if (matched === 'ACME') return forms.screaming;
  if (matched === 'Acme')
    return capitalizedReplacement(text, start, forms, mode);
  const before = text.charAt(start - 1);
  const after = text.charAt(end);
  if (/[A-Z]/.test(after)) return forms.camel;
  if (before === '_' || after === '_' || inside(spans, start))
    return forms.snake;
  return forms.kebab;
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Renames every placeholder occurrence in `text` (see module docs). */
export function renameText(
  text: string,
  names: Names,
  mode: Mode = {},
): string {
  const forms = nameForms(names);
  const withRepo =
    names.repo && names.templateRepo
      ? text.replace(
          new RegExp(
            `(?<![A-Za-z0-9_.-])${escapeRegExp(names.templateRepo)}(?![A-Za-z0-9_-])`,
            'g',
          ),
          names.repo,
        )
      : text;
  const spans = postgresSpans(withRepo);
  return withRepo.replace(/acme/gi, (matched, offset: number) =>
    replacement(withRepo, offset, matched, forms, spans, mode),
  );
}

/** Renames every segment of a `/`-separated relative path. */
export const renamePath = (path: string, names: Names): string =>
  path
    .split('/')
    .map((segment) => renameText(segment, names, { path: true }))
    .join('/');

/** Binary files (a NUL byte in the first 8 KiB) are copied untouched. */
export const isBinary = (bytes: Uint8Array): boolean =>
  bytes.subarray(0, 8192).includes(0);
