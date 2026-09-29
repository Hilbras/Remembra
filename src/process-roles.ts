/**
 * Process roles (V5.6.0, roadmap §28).
 *
 * One process can do everything, which is the default and stays the default. The
 * roles exist so a deployment *can* split the duties, not because splitting is
 * required — a single-process install must keep working with no configuration at
 * all, which is why the no-subcommand case is `all` rather than a choice.
 *
 * ## Why duties are refused rather than ignored
 *
 * A `worker` started with `--port 8080` looks like a misconfiguration but would
 * otherwise bind a port and serve traffic nobody intended it to serve, from a
 * process whose whole premise is that it has no HTTP surface. That is a security
 * regression wearing a convenience feature, so it is a startup error. The
 * converse matters too: a `serve` process that quietly also ran maintenance jobs
 * would re-introduce audit S4's duplicated work across instances.
 */
import { RemembraError } from "./errors.js";

export type ProcessRole = "all" | "server" | "worker" | "scheduler";

export interface Duties {
  /** Bind an HTTP listener and drain webhooks. */
  readonly http: boolean;
  /** Run a durable worker polling the job ledger. */
  readonly worker: boolean;
  /** Enqueue periodic jobs onto the ledger. */
  readonly scheduler: boolean;
}

const DUTIES: Record<ProcessRole, Duties> = {
  // The default: everything in one process, exactly as before this milestone.
  all: { http: true, worker: true, scheduler: true },
  server: { http: true, worker: false, scheduler: false },
  worker: { http: false, worker: true, scheduler: false },
  scheduler: { http: false, worker: false, scheduler: true },
};

/** The subcommands that select a role. Anything else is a data verb. */
const ROLE_COMMANDS: Record<string, ProcessRole> = {
  serve: "server",
  worker: "worker",
  scheduler: "scheduler",
};

export function dutiesFor(role: ProcessRole): Duties {
  return DUTIES[role];
}

/** The role a subcommand selects, or `undefined` if it is not a role command. */
export function roleForCommand(command: string | undefined): ProcessRole | undefined {
  return command === undefined ? undefined : ROLE_COMMANDS[command];
}

/**
 * Work out the role from argv, and the arguments with the subcommand removed.
 *
 * Returning the rest matters: the existing verbs (`store`, `search`, `import`, …)
 * take arguments, and consuming the subcommand must not shift them by one.
 */
export function resolveRole(argv: readonly string[]): { role: ProcessRole; argv: string[] } {
  const [first, ...rest] = argv;
  const role = roleForCommand(first);
  if (role === undefined) return { role: "all", argv: [...argv] };
  // A data verb after a role command is never valid, and is caught below.
  return { role, argv: [first, ...rest] };
}

/**
 * Reject a role asked to do a duty it does not hold.
 *
 * The messages name the conflict rather than saying "invalid arguments", because
 * the most likely cause is a deployment script that grew a flag and nobody
 * re-read what the subcommand now means.
 */
export function assertDuties(role: ProcessRole, argv: readonly string[]): void {
  const duties = DUTIES[role];
  if (duties.http) return;

  const wantsHttp = argv.includes("--http");
  const portFlag = argv.indexOf("--port");
  if (wantsHttp || portFlag !== -1) {
    throw new RemembraError(
      "INVALID_INPUT",
      `the "${role}" role has no HTTP surface; drop --http/--port, or use "remembra serve"`,
    );
  }

  // A role process has no store, search, or snapshot duties, so a verb aimed at
  // the data would be silently ignored. The verb follows the subcommand, so the
  // subcommand is skipped before looking for one.
  const afterSubcommand = argv[0] === role ? argv.slice(1) : argv;
  const first = afterSubcommand.find((argument) => !argument.startsWith("-"));
  if (first !== undefined) {
    throw new RemembraError(
      "INVALID_INPUT",
      `the "${role}" role does not serve the "${first}" command; run it with "remembra" or "remembra serve"`,
    );
  }
}
