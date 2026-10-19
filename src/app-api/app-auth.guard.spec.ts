import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { AppAuthGuard } from "./app-auth.guard";
import { AppAuthService } from "./app-auth.service";

interface TestRequest {
  headers: Record<string, string | string[] | undefined>;
  appSession?: { sessionId: string; userId: string };
}

function buildContext(headers: Record<string, string | string[] | undefined>) {
  const request: TestRequest = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe("AppAuthGuard", () => {
  function buildGuard(validateSession: jest.Mock) {
    const appAuth = {
      validateSession,
    } as unknown as AppAuthService;
    return new AppAuthGuard(appAuth);
  }

  it("rejects when the Authorization header is missing", async () => {
    const guard = buildGuard(jest.fn());
    const { context } = buildContext({});
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("rejects a non-Bearer Authorization header", async () => {
    const guard = buildGuard(jest.fn());
    const { context } = buildContext({ authorization: "Basic abc" });
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("rejects when the token does not resolve to a live session", async () => {
    const validateSession = jest.fn().mockResolvedValue(null);
    const guard = buildGuard(validateSession);
    const { context } = buildContext({ authorization: "Bearer invalid-token" });
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(validateSession).toHaveBeenCalledWith("invalid-token");
  });

  it("attaches the resolved session to the request on success", async () => {
    const session = { sessionId: "s-1", userId: "user-1" };
    const validateSession = jest.fn().mockResolvedValue(session);
    const guard = buildGuard(validateSession);
    const { context, request } = buildContext({
      authorization: "Bearer valid-token",
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.appSession).toEqual(session);
  });
});
