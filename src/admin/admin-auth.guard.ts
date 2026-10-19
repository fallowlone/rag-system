import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { safeCompare } from "../common/safe-compare";

interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
}

const GENERIC_REJECT = "Unauthorized";

@Injectable()
export class AdminAuthGuard implements CanActivate {
  private readonly logger = new Logger(AdminAuthGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    const rawHeader = request.headers["x-admin-token"];
    const tokenHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    const secret = process.env.ADMIN_API_TOKEN;
    if (!secret) {
      this.logger.warn("ADMIN_API_TOKEN is not set — rejecting all requests");
      throw new UnauthorizedException(GENERIC_REJECT);
    }

    if (!tokenHeader) {
      this.logger.debug("admin auth: missing x-admin-token header");
      throw new UnauthorizedException(GENERIC_REJECT);
    }

    if (!safeCompare(tokenHeader, secret)) {
      this.logger.debug("admin auth: invalid token");
      throw new UnauthorizedException(GENERIC_REJECT);
    }

    return true;
  }
}
