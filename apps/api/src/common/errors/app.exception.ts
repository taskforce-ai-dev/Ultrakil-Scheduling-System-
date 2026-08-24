import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCodeValue } from './error-codes';

export interface AppErrorBody {
  /** Stable machine-readable code. Clients branch on this. */
  code: ErrorCodeValue;
  /** Actionable, human-readable message. Safe to show to a manager. */
  message: string;
  /** Optional structured context, e.g. which rule failed for which employee. */
  details?: Record<string, unknown>;
}

/**
 * Base class for every deliberate error the API raises. Guarantees that the
 * response body always carries a stable `code`.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCodeValue,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details } satisfies AppErrorBody, status);
  }
}

export class ResourceNotFoundException extends AppException {
  constructor(resource: string, id: string) {
    super(
      'RESOURCE_NOT_FOUND',
      `${resource} "${id}" was not found. Check the identifier, or refresh the list — it may have been removed.`,
      HttpStatus.NOT_FOUND,
      { resource, id },
    );
  }
}
