export const WOJ_CLI_VERSION = "0.2.3";

/** Stable process exit codes. They are part of the public CLI contract. */
export const WOJ_EXIT = Object.freeze({
  success: 0,
  unsuccessful: 1,
  usage: 2,
  authentication: 3,
  integrity: 4,
  conflict: 5,
  infrastructure: 6,
  localIntegrity: 7,
} as const);

export type WojExitCode = typeof WOJ_EXIT[keyof typeof WOJ_EXIT];
export type CommandBoundary = "local" | "remote" | "network";

export interface CommandSpec {
  readonly path: readonly string[];
  readonly summary: string;
  readonly boundary: CommandBoundary;
  readonly usage?: string;
  readonly options?: Readonly<Record<string, "boolean" | "string" | "repeatable">>;
}

const local = (path: string, summary: string, usage?: string, options?: CommandSpec["options"]): CommandSpec => ({
  path: path.split(" "), summary, boundary: "local", usage, options,
});
const remote = (path: string, summary: string, usage?: string, options?: CommandSpec["options"]): CommandSpec => ({
  path: path.split(" "), summary, boundary: "remote", usage, options,
});
const network = (path: string, summary: string, usage?: string, options?: CommandSpec["options"]): CommandSpec => ({
  path: path.split(" "), summary, boundary: "network", usage, options,
});

const paging = { limit: "string", cursor: "string" } as const;
const wait = { wait: "boolean" } as const;
const language = { language: "string", target: "string", optimization: "string", entry: "string" } as const;

/** The complete Issue #42 command tree. Every leaf is dispatched explicitly. */
export const WOJ_COMMANDS: readonly CommandSpec[] = Object.freeze([
  remote("auth login", "Sign in through the browser device flow.", "", { "device-name": "string" }),
  remote("auth logout", "Revoke the current CLI session."),
  remote("auth status", "Show the signed-in account and roles."),

  local("init", "Create a local woj workspace.", "[directory]", { ...language, name: "string", force: "boolean" }),
  local("build", "Compile the current workspace without network access."),
  local("run", "Compile and run locally; makes no correctness claim.", "", { input: "string", text: "string", arg: "repeatable" }),
  local("test", "Run only locally available public/sample cases.", "", { case: "repeatable" }),
  local("bench", "Benchmark the local program.", "", { iterations: "string", stdin: "string" }),
  local("watch", "Re-run a local action after workspace files change.", "", { command: "string" }),

  remote("problem list", "List active public problems.", "", { locale: "string" }),
  remote("problem show", "Show one active public problem.", "<problem-id>", { locale: "string", contest: "string" }),
  remote("problem pull", "Pull and pin one problem at its active catalog commit.", "<problem-id> [directory]", { locale: "string", language: "string", contest: "string", force: "boolean" }),

  remote("submit", "Create an Official Submit from the pinned workspace.", "", { ...language, contest: "string", wait: "boolean" }),
  remote("submission list", "List your Official Submits.", "", paging),
  remote("submission show", "Show an Official Submit.", "<submission-id>"),
  remote("submission watch", "Wait for an Official Submit to settle.", "<submission-id>", { interval: "string" }),
  remote("submission cancel", "Cancel an unsettled Official Submit.", "<submission-id>"),
  remote("submission source", "Download visible source for an Official Submit.", "<submission-id>"),
  remote("submission policy", "Show the submission policy summary.", "<submission-id>"),

  remote("contest list", "List visible contests."),
  remote("contest show", "Show one contest.", "<contest-id>"),
  remote("contest join", "Join a contest; invite contests require --code-file.", "<contest-id>", { "code-file": "string" }),
  remote("contest problems", "List projected locked, open, and closed contest problem states.", "<contest-id>"),
  remote("contest standings", "Show contest standings.", "<contest-id>", { limit: "string" }),

  remote("performance frontier", "Show the verified performance frontier.", "<problem-id>", { language: "string", contest: "string" }),
  remote("performance evolution", "Show your verified performance evolution.", "<problem-id>", { language: "string", contest: "string" }),

  local("judge inspect", "Inspect a complete local judge package.", "<judge-package>"),
  local("judge verify", "Verify a complete local judge package deterministically.", "<judge-package>", { sha256: "string", bytes: "string" }),
  local("judge execute", "Execute a source workspace against a complete local judge package.", "<judge-package>", { source: "string", all: "boolean" }),

  local("toolchain list", "List explicitly installed toolchains."),
  local("toolchain info", "Show one installed toolchain.", "<toolchain-id>"),
  network("toolchain fetch", "Fetch one pinned toolchain explicitly.", "<toolchain-id>"),
  local("toolchain verify", "Verify installed toolchain bytes and digests.", "[toolchain-id]"),
  local("toolchain prune", "Remove unreferenced toolchain assets.", "", { yes: "boolean" }),

  remote("organizer repo list", "List authorized Organizer repositories."),
  remote("organizer repo show", "Show one authorized Organizer repository.", "<repository-id>"),
  local("organizer collection init", "Create a collection authoring skeleton.", "[directory]", { force: "boolean" }),
  local("organizer collection build", "Build repository manifests and deployable bundles locally.", "[directory]", { source: "string" }),
  local("organizer collection verify", "Verify repository manifests and deployable bundles without executing judge code.", "[directory]", { source: "string" }),
  remote("organizer catalog list", "List connected repository catalogs."),
  remote("organizer catalog show", "Show one connected repository catalog.", "<catalog-id>"),
  remote("organizer catalog connect", "Connect one authorized GitHub repository.", "", { repo: "string" }),
  remote("organizer catalog sync", "Resolve one ref and sync its exact commit.", "<catalog-id>", { ref: "string", ...wait }),
  remote("organizer catalog sync-show", "Show or watch one catalog sync.", "<sync-id>", { watch: "boolean", interval: "string" }),

  remote("organizer contest list", "List contests you organize."),
  remote("organizer contest show", "Show one Organizer contest.", "<contest-id>"),
  remote("organizer contest invite-rotate", "Rotate an invite contest credential.", "<contest-id>", { "code-file": "string" }),
  remote("organizer contest participants", "List contest entrants.", "<contest-id>", paging),
  remote("organizer contest standings", "Show organizer-visible standings.", "<contest-id>", { limit: "string" }),

  remote("organizer rejudge options", "List known commits or valid targets for one problem revision.", "[problem-id]", { from: "string" }),
  remote("organizer rejudge start", "Start a commit-to-commit rejudge batch.", "<problem-id>", { from: "string", to: "string", contest: "string", ...wait }),
  remote("organizer rejudge list", "List rejudge batches.", "", { limit: "string" }),
  remote("organizer rejudge show", "Show one rejudge batch.", "<batch-id>"),
  remote("organizer rejudge watch", "Wait for a rejudge batch to settle.", "<batch-id>", { interval: "string" }),
  remote("organizer rejudge cancel", "Cancel an unsettled rejudge batch.", "<batch-id>"),

  local("config list", "List non-secret CLI configuration."),
  local("config get", "Read one configuration value.", "<key>"),
  local("config set", "Set one configuration value.", "<key> <value>"),
  local("config unset", "Remove one configuration value.", "<key>"),
  local("cache status", "Show local cache usage."),
  local("cache prune", "Prune unreferenced local cache entries.", "", { yes: "boolean" }),
  local("cache clear", "Clear the local cache.", "", { yes: "boolean" }),
  local("doctor", "Check explicit runtime, toolchain, workspace, auth, and server configuration."),
  local("completion", "Print a shell completion script.", "<bash|zsh|fish>"),
  local("version", "Print the woj CLI version."),
]);

export function commandKey(path: readonly string[]): string {
  return path.join(" ");
}

export const COMMAND_BY_KEY: ReadonlyMap<string, CommandSpec> = new Map(
  WOJ_COMMANDS.map((command) => [commandKey(command.path), command]),
);
