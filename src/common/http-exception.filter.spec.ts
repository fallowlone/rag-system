import {
  ArgumentsHost,
  BadRequestException,
  InternalServerErrorException,
} from "@nestjs/common";
import { GlobalExceptionFilter } from "./http-exception.filter";

describe("GlobalExceptionFilter", () => {
  function buildHost() {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: "GET", url: "/app/v1/sync" }),
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;
    return { host, status, json };
  }

  it("passes HttpExceptions through untouched (status + body)", () => {
    const { host, status, json } = buildHost();

    new GlobalExceptionFilter().catch(
      new BadRequestException("cursor must be a valid sync cursor"),
      host,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("maps an unexpected throw to a generic 500 with a correlation id (no internals leak)", () => {
    const { host, status, json } = buildHost();

    new GlobalExceptionFilter().catch(
      new Error("SELECT * FROM pg_shadow ... connection string ..."),
      host,
    );

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(body.message).toBe("Internal server error");
    expect(typeof body.correlationId).toBe("string");
    expect(JSON.stringify(body)).not.toContain("pg_shadow");
  });

  it("maps a Prisma P2002 into the same generic 500 envelope", () => {
    const { host, status, json } = buildHost();
    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
    });

    new GlobalExceptionFilter().catch(p2002, host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Internal server error" }),
    );
  });

  it("logs 5xx HttpExceptions but still passes them through", () => {
    const { host, status } = buildHost();

    new GlobalExceptionFilter().catch(
      new InternalServerErrorException("database clock unavailable"),
      host,
    );

    expect(status).toHaveBeenCalledWith(500);
  });
});
