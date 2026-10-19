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

@Injectable()
export class DocvaultAuthGuard implements CanActivate {
  private readonly logger = new Logger(DocvaultAuthGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    const rawHeader = request.headers["authorization"];
    const authHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    const secret = process.env.RAG_BOT_SECRET;
    if (!secret) {
      this.logger.warn("RAG_BOT_SECRET is not set — rejecting all requests");
      throw new UnauthorizedException("Service not configured");
    }

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new UnauthorizedException(
        "Missing or invalid Authorization header",
      );
    }

    const token = authHeader.slice("Bearer ".length);
    if (!safeCompare(token, secret)) {
      throw new UnauthorizedException("Invalid token");
    }

    return true;
  }
}
