/**
 * The wizard's injected effects. Steps receive a `WizardDeps` and never
 * touch processes, the terminal, the network or the file system directly,
 * so every step runs under fakes in the tests.
 */
import { shown, type Command } from './wizard-plan';

export type Captured = { readonly code: number; readonly stdout: string };

/** How a long-running process ended: its code and the tail of its output. */
export type Stopped = { readonly code: number; readonly output: string };

export type RunOptions = {
  readonly cwd?: string;
  /** Extra environment for the child; values are never displayed. */
  readonly env?: Readonly<Record<string, string>>;
};

export type Runner = {
  /** A read-only check (versions, login status). Runs in dry runs too. */
  readonly probe: (command: Command, options?: RunOptions) => Captured;
  /** Runs attached to the terminal; returns the exit code. */
  readonly run: (command: Command, options?: RunOptions) => number;
  /**
   * A PageSpace consent flow (`pagespace keys create --show-token`): stdin
   * attached, stdout captured and never shown, stderr filtered to the lines
   * needed to approve (`scripts/pagespace-consent.ts`).
   */
  readonly consent: (
    command: Command,
    options?: RunOptions,
  ) => Promise<Captured>;
  /**
   * A long-running process (the dev server): its output is shown as it
   * comes, and its last few kilobytes are kept to explain an early exit.
   */
  readonly start: (command: Command, options?: RunOptions) => Promise<Stopped>;
};

export type Choice<T extends string> = {
  readonly value: T;
  readonly label: string;
};

export type Prompt = {
  readonly text: (
    question: string,
    fallback: string,
    validate?: (answer: string) => string | null,
  ) => Promise<string>;
  readonly confirm: (question: string, fallback: boolean) => Promise<boolean>;
  readonly select: <T extends string>(
    question: string,
    choices: readonly Choice<T>[],
    fallback: T,
  ) => Promise<T>;
  /** Waits for Enter. */
  readonly pause: (message: string) => Promise<void>;
};

export type WizardDeps = {
  readonly runner: Runner;
  readonly prompt: Prompt;
  readonly open: (url: string) => void;
  readonly log: (line: string) => void;
  readonly platform: string;
  readonly cwd: string;
  readonly isPortFree: (port: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * Keeps Ctrl-C from killing the wizard itself (the child it is running
   * still stops), so cleanup after it runs. Returns the release function,
   * which reports whether Ctrl-C was pressed while held.
   */
  readonly holdInterrupts: () => () => boolean;
  /** True once the server answers HTTP below 400 at `url`. */
  readonly reachable: (url: string) => Promise<boolean>;
  readonly readFile: (path: string) => string | null;
  readonly writeFile: (path: string, text: string) => void;
  /** Bun running the wizard, and the version the template pins. */
  readonly bunVersion: string;
  readonly pinnedBunVersion: string | null;
};

/** Thrown to stop the wizard with a plain-language message. */
export class WizardStop extends Error {
  constructor(
    message: string,
    readonly code: number = 1,
  ) {
    super(message);
  }
}

/** How a command is displayed: env names visible, values masked. */
export function display(command: Command, options: RunOptions = {}): string {
  const env = Object.keys(options.env ?? {}).map((key) => `${key}=***`);
  const where = options.cwd ? `   (in ${options.cwd})` : '';
  return `$ ${[...env, shown(command)].join(' ')}${where}`;
}

/**
 * Shows an external action, then runs it (attached to the terminal) unless
 * this is a dry run. Every mutating command goes through here.
 */
export function act(
  deps: WizardDeps,
  dryRun: boolean,
  command: Command,
  options: RunOptions = {},
): number {
  deps.log(`  ${dryRun ? '[dry run] ' : ''}${display(command, options)}`);
  if (dryRun) return 0;
  return deps.runner.run(command, options);
}
