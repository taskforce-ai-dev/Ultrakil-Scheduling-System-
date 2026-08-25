import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException, AppErrorBody } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * Turns every thrown error into one predictable envelope:
 *
 *   { code, message, details?, path, timestamp }
 *
 * Unexpected errors are logged with their stack but never leak internals to the
 * client — the manager sees an actionable message, the log keeps the detail.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, body } = this.toErrorResponse(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} ${body.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} -> ${status} ${body.code}: ${body.message}`,
      );
    }

    response.status(status).json({
      ...body,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private toErrorResponse(exception: unknown): {
    status: number;
    body: AppErrorBody;
  } {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        body: exception.getResponse() as AppErrorBody,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();

      // A thrown Nest exception may already carry our envelope — the auth
      // guards throw UnauthorizedException({ code, message }) rather than
      // subclassing AppException. Honour the code it chose; overwriting it
      // here is how AUTHENTICATION_REQUIRED came back as RESOURCE_CONFLICT.
      if (
        typeof raw === 'object' &&
        raw !== null &&
        'code' in raw &&
        typeof (raw as { code: unknown }).code === 'string'
      ) {
        return { status, body: raw as AppErrorBody };
      }

      // Nest's ValidationPipe returns { message: string[] , error, statusCode }.
      if (typeof raw === 'object' && raw !== null && 'message' in raw) {
        const messages = (raw as { message: unknown }).message;
        const message = Array.isArray(messages)
          ? messages.join('; ')
          : String(messages);
        return {
          status,
          body: {
            code:
              status === HttpStatus.BAD_REQUEST
                ? ErrorCode.VALIDATION_FAILED
                : ErrorCode.RESOURCE_CONFLICT,
            message,
          },
        };
      }

      return {
        status,
        body: { code: ErrorCode.INTERNAL_ERROR, message: String(raw) },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: ErrorCode.INTERNAL_ERROR,
        message:
          'Something went wrong on the server. The team has been notified — please retry, and report the timestamp if it persists.',
      },
    };
  }
}
