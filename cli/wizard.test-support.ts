/** Fake `WizardDeps` for the wizard tests: records every effect. */
import type { Captured, Prompt, WizardDeps } from './wizard-deps';

export type FakeOptions = {
  /** Probe results by joined command; unlisted probes succeed. */
  readonly probes?: Readonly<Record<string, Captured>>;
  readonly capture?: (command: string) => Captured;
  readonly run?: (command: string) => number;
  readonly files?: Record<string, string>;
  readonly isPortFree?: (port: number) => boolean;
  readonly platform?: string;
  readonly prompt?: Partial<Prompt>;
};

export type Fake = {
  readonly deps: WizardDeps;
  readonly logs: string[];
  /** Commands run attached (run, capture, start), joined with spaces. */
  readonly ran: string[];
  readonly opened: string[];
  readonly files: Record<string, string>;
  readonly envs: Record<string, Readonly<Record<string, string>>>;
};

const refuse = (question: string): never => {
  throw new Error(`unexpected question: ${question}`);
};

export function fakeDeps(options: FakeOptions = {}): Fake {
  const logs: string[] = [];
  const ran: string[] = [];
  const opened: string[] = [];
  const files: Record<string, string> = { ...options.files };
  const envs: Record<string, Readonly<Record<string, string>>> = {};
  const record = (
    command: readonly string[],
    env?: Readonly<Record<string, string>>,
  ) => {
    const line = command.join(' ');
    ran.push(line);
    if (env) envs[line] = env;
    return line;
  };
  const deps: WizardDeps = {
    runner: {
      probe: (command) =>
        options.probes?.[command.join(' ')] ?? { code: 0, stdout: '' },
      run: (command, run) => {
        const line = record(command, run?.env);
        return options.run?.(line) ?? 0;
      },
      capture: (command) => {
        const line = record(command);
        return options.capture?.(line) ?? { code: 0, stdout: '' };
      },
      start: async (command) => {
        record(command);
        return 0;
      },
    },
    prompt: {
      text: async (question) => refuse(question),
      confirm: async (question) => refuse(question),
      select: async (question) => refuse(question),
      pause: async (message) => refuse(message),
      ...options.prompt,
    },
    open: (url) => opened.push(url),
    log: (line) => logs.push(line),
    platform: options.platform ?? 'darwin',
    cwd: '/work',
    isPortFree: options.isPortFree ?? (() => true),
    sleep: async () => {},
    holdInterrupts: () => () => {},
    reachable: async () => true,
    readFile: (path) => files[path] ?? null,
    writeFile: (path, text) => {
      files[path] = text;
    },
    bunVersion: '1.4.2',
    pinnedBunVersion: '1.4.2',
  };
  return { deps, logs, ran, opened, files, envs };
}
