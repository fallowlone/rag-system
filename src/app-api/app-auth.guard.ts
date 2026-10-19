import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { AppAuthService } from "./app-auth.service";
import { AppAuthedRequest } from "./app-api.types";

const GENERIC_REJECT = "Unauthorized";

/**
 * Bearer-token guard for /app/v1 routes. Validates the device token via
 * AppAuthService (DB-backed, revocable) and attaches the resolved session to
 * the request as `appSession` — controllers never see a raw token.
 */
@Injectable()
export class AppAuthGuard implements CanActivate {
  private readonly logger = new Logger(AppAuthGuard.name);

  constructor(private readonly appAuth: AppAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppAuthedRequest>();
    const rawHeader = request.headers["authorization"];
    const authHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      this.logger.debug("app auth: missing or invalid Authorization header");
      throw new UnauthorizedException(GENERIC_REJECT);
    }

    const token = authHeader.slice("Bearer ".length);
    const session = await this.appAuth.validateSession(token);
    if (!session) {
      this.logger.debug("app auth: unknown or revoked device token");
      throw new UnauthorizedException(GENERIC_REJECT);
    }

    request.appSession = session;
    return true;
  }
}
