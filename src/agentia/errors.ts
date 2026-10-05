/**
 * Typed errors for everything that can go wrong between timemachine and the Agentia CLI.
 * Each error carries a stable `code`, a process `exitCode` and a human `hint`, so both people
 * and agents (via --json) know what to do next.
 */

export const ExitCode = {
  Ok: 0,
  Generic: 1,
  Usage: 2,
  AuthMissing: 3,
  NotFound: 4,
  Legacy: 5,
  Conflict: 6,
  AgentiaUnavailable: 7,
  Gateway: 8,
  Validation: 9,
  OrgBusy: 10,
} as const

export type ErrorCode =
  | 'AGENTIA_NOT_INSTALLED'
  | 'AGENTIA_VERSION_UNSUPPORTED'
  | 'AGENTIA_TIMEOUT'
  | 'AGENTIA_USAGE'
  | 'AGENTIA_UNEXPECTED_OUTPUT'
  | 'AGENTIA_COMMAND_FAILED'
  | 'AUTH_MISSING'
  | 'TEMPLATE_NOT_FOUND'
  | 'TEMPLATE_LEGACY'
  | 'TEMPLATE_AMBIGUOUS'
  | 'TEMPLATE_VALIDATION'
  | 'SOURCE_ORG_LOGIN'
  | 'GATEWAY'
  | 'NOT_INITIALISED'
  | 'NO_SNAPSHOT'
  | 'GIT'
  | 'CONFLICT'
  | 'ORG_BUSY'
  | 'VERIFY_FAILED'
  | 'CONFIRMATION_REQUIRED'
  | 'SAVE_BLOCKED'
  | 'INVALID_DOCUMENT'
  | 'NO_EDIT_SESSION'
  | 'EDIT_IN_PROGRESS'
  | 'SKILL_CONFLICT'

export interface ErrorDetails {
  hint?: string
  transactionId?: string
  /** Agentia/Copado error categories such as DAT-004, LGN-001, MDW-003. */
  categories?: string[]
  statusCode?: number
  [key: string]: unknown
}

export class TimemachineError extends Error {
  readonly code: ErrorCode
  readonly exitCode: number
  readonly details: ErrorDetails

  constructor(code: ErrorCode, message: string, exitCode: number, details: ErrorDetails = {}) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }

  get hint(): string | undefined {
    return this.details.hint
  }

  toJSON(): Record<string, unknown> {
    return {code: this.code, message: this.message, exitCode: this.exitCode, ...this.details}
  }
}

export class AgentiaNotInstalledError extends TimemachineError {
  constructor(bin: string) {
    super('AGENTIA_NOT_INSTALLED', `The Agentia CLI (${bin}) was not found.`, ExitCode.AgentiaUnavailable, {
      hint: 'Install it with `npm install -g @copado/agentia-cli@beta`, or point TM_AGENTIA_BIN at the binary.',
    })
  }
}

export class AgentiaVersionError extends TimemachineError {
  constructor(found: string, required: string) {
    super(
      'AGENTIA_VERSION_UNSUPPORTED',
      `Agentia CLI ${found} is older than the minimum supported version ${required}.`,
      ExitCode.AgentiaUnavailable,
      {hint: 'Run `agentia update` to get the newest beta.', found, required},
    )
  }
}

export class AgentiaTimeoutError extends TimemachineError {
  constructor(command: string, timeoutMs: number) {
    super('AGENTIA_TIMEOUT', `\`agentia ${command}\` did not finish within ${Math.round(timeoutMs / 1000)}s.`, ExitCode.Gateway, {
      hint: 'Check your network connection and retry. Raise the limit with TM_AGENTIA_TIMEOUT_MS.',
    })
  }
}

export class AgentiaUsageError extends TimemachineError {
  constructor(command: string) {
    super('AGENTIA_USAGE', `timemachine called \`agentia ${command}\` with invalid arguments.`, ExitCode.Generic, {
      hint: 'This is a timemachine bug. Please report it with the command you ran.',
    })
  }
}

export class UnexpectedOutputError extends TimemachineError {
  constructor(command: string, problem: string) {
    super('AGENTIA_UNEXPECTED_OUTPUT', `Unexpected output from \`agentia ${command}\`: ${problem}`, ExitCode.Generic, {
      hint: 'The Agentia CLI output format may have changed. Run `agentia update` or report this.',
    })
  }
}

export class AuthMissingError extends TimemachineError {
  constructor(message: string, transactionId?: string) {
    super('AUTH_MISSING', message, ExitCode.AuthMissing, {
      hint: 'Run `agentia setup` in this project folder (or set AGENTIA_CICD_API_KEY) and try again.',
      transactionId,
    })
  }
}

export class TemplateNotFoundError extends TimemachineError {
  constructor(ref: string, details: ErrorDetails = {}) {
    super('TEMPLATE_NOT_FOUND', `Data template "${ref}" was not found.`, ExitCode.NotFound, {
      hint: 'List templates with `agentia cicd data template list`.',
      ...details,
    })
  }
}

export class TemplateAmbiguousError extends TimemachineError {
  constructor(ref: string, ids: string[]) {
    super('TEMPLATE_AMBIGUOUS', `More than one data template is named "${ref}".`, ExitCode.Usage, {
      hint: 'Use the template Id instead of its name.',
      candidates: ids,
    })
  }
}

export class LegacyTemplateError extends TimemachineError {
  constructor(name: string, id: string) {
    super('TEMPLATE_LEGACY', `Data template "${name}" is a legacy template and has no v2 detail document yet.`, ExitCode.Legacy, {
      hint: `Convert it once with \`agentia cicd data template convert-old ${id}\` (this writes to the org), then retry.`,
      templateId: id,
    })
  }
}

/** Copado rejected a template detail document (HTTP 422, category MDW-003). */
export class TemplateValidationError extends TimemachineError {
  constructor(message: string, problems: ValidationProblem[], details: ErrorDetails = {}) {
    super('TEMPLATE_VALIDATION', message, ExitCode.Validation, {
      hint:
        problems
          .map((p) => p.hint)
          .filter(Boolean)
          .join(' ') || undefined,
      problems,
      ...details,
    })
  }
}

export interface ValidationProblem {
  /** Path as reported by Copado, e.g. `details.0.limit`. */
  path: string
  /** Copado's error kind, e.g. `missing`, `list_type`. */
  kind: string
  message: string
  hint?: string
}

export class SourceOrgLoginError extends TimemachineError {
  constructor(message: string, details: ErrorDetails = {}) {
    super('SOURCE_ORG_LOGIN', message, ExitCode.Gateway, {
      hint:
        "Copado could not log in to the template's source org. Check that your user has the Copado Data Deployer licence, " +
        'then re-authenticate the credential (`agentia cicd environment auth web login <environment-id>`).',
      ...details,
    })
  }
}

export class GatewayError extends TimemachineError {
  constructor(message: string, details: ErrorDetails = {}) {
    super('GATEWAY', message, ExitCode.Gateway, {
      hint: 'Copado returned an error. Retry, and quote the transaction Id if you contact support.',
      ...details,
    })
  }
}

export class AgentiaCommandError extends TimemachineError {
  constructor(message: string, details: ErrorDetails = {}) {
    super('AGENTIA_COMMAND_FAILED', message, ExitCode.Generic, details)
  }
}

export class NotInitialisedError extends TimemachineError {
  constructor(start: string) {
    super('NOT_INITIALISED', `No timemachine workspace found in ${start} or its parent folders.`, ExitCode.Usage, {
      hint: 'Run `agentia timemachine init` in the folder that should hold your template snapshots.',
    })
  }
}

export class NoSnapshotError extends TimemachineError {
  constructor(name: string) {
    super('NO_SNAPSHOT', `"${name}" has no snapshots yet.`, ExitCode.NotFound, {
      hint: `Take one with \`agentia timemachine snapshot "${name}"\`.`,
    })
  }
}

export class GitError extends TimemachineError {
  constructor(message: string, hint?: string) {
    super('GIT', message, ExitCode.Generic, {hint})
  }
}

/** Someone changed the template in Copado between our read and our write. */
export class ConcurrencyError extends TimemachineError {
  constructor(name: string, expectedHash: string, actualHash: string, details: ErrorDetails = {}) {
    super('CONFLICT', `"${name}" was changed in Copado while you were working on it. Nothing was saved.`, ExitCode.Conflict, {
      hint: 'Review the other change with `agentia timemachine diff`, then start again from the current version.',
      expectedHash,
      actualHash,
      ...details,
    })
  }
}

export class OrgBusyError extends TimemachineError {
  constructor(file: string, contents: string) {
    super('ORG_BUSY', `Another write to the org is in progress (${file}): ${contents.trim() || '(no details)'}`, ExitCode.OrgBusy, {
      hint: 'Wait for it to finish. If the lock is stale, delete the file or re-run with --ignore-busy.',
      lockFile: file,
      lockContents: contents.trim(),
    })
  }
}

export class VerifyError extends TimemachineError {
  constructor(name: string, expectedHash: string, actualHash: string) {
    super('VERIFY_FAILED', `Saved "${name}", but reading it back does not match what was sent.`, ExitCode.Generic, {
      hint: 'Copado may have adjusted the document. Inspect it with `agentia timemachine diff` against the target version.',
      expectedHash,
      actualHash,
    })
  }
}

export class ConfirmationRequiredError extends TimemachineError {
  constructor(action: string) {
    super('CONFIRMATION_REQUIRED', `${action} needs confirmation, but there is no interactive terminal.`, ExitCode.Usage, {
      hint: 'Review the diff, then re-run with --yes (or --dry-run to only preview).',
    })
  }
}

/** The document cannot be saved as-is (required fields empty); detected before any write. */
export class SaveBlockedError extends TimemachineError {
  constructor(name: string, fixes: string[]) {
    super('SAVE_BLOCKED', `Copado would reject "${name}": required fields are empty. Nothing was saved.`, ExitCode.Validation, {
      hint: [...new Set(fixes)].join(' '),
      fixes,
    })
  }
}

export class InvalidDocumentError extends TimemachineError {
  constructor(file: string, problem: string) {
    super('INVALID_DOCUMENT', `The edited document ${file} is not valid: ${problem}`, ExitCode.Usage, {
      hint: 'Fix the file and run the same command again. Nothing was saved.',
      file,
    })
  }
}

export class NoEditSessionError extends TimemachineError {
  constructor(name: string, session: string) {
    super('NO_EDIT_SESSION', `There is no edit of "${name}" in progress for session "${session}".`, ExitCode.Usage, {
      hint: `Start one with \`agentia timemachine edit "${name}" --start\`.`,
    })
  }
}

export class EditInProgressError extends TimemachineError {
  constructor(name: string, session: string, startedAt: string, file: string) {
    super('EDIT_IN_PROGRESS', `An edit of "${name}" (session "${session}") has been in progress since ${startedAt}.`, ExitCode.Usage, {
      hint: `Continue with \`agentia timemachine edit "${name}" --apply\` (working copy: ${file}) or discard it with --abort.`,
      file,
    })
  }
}
