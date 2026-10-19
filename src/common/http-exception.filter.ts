import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";

/**
 * Last-resort exception boundary: HttpExceptions keep their status/body
 * (they are deliberately shaped by guards/pipes/services), while every
 * unexpected throw becomes a generic 500 with a correlation id. The stack
 * and request line go to the server log only — never to the client — so
 * Prisma/Anthropic/Redis internals can't leak through error responses.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (status >= 500) {
        this.logger.error(
          `HTTP ${status} ${req.method} ${req.url}`,
          exception.stack,
        );
      }
      res.status(status).json(body);
      return;
    }

    const correlationId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.logger.error(
      `Unhandled ${req.method} ${req.url} [${correlationId}]`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: "Internal server error",
      correlationId,
    });
  }
}
