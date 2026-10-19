import { createHash } from "crypto";
import { AppAuthService } from "./app-auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../cache/cache.service";

const SECRET = "a".repeat(64);
const SECRET_HASH = createHash("sha256").update(SECRET).digest("hex");

describe("AppAuthService", () => {
  function buildService(options?: {
    storedProposal?: { deviceName: string; secretHash: string } | null;
    storedClaim?: {
      token: string;
      sessionId: string;
      userId: string;
      secretHash: string;
    } | null;
    session?: Record<string, unknown> | null;
    consumeResult?: { deviceName: string; secretHash: string } | null;
    createError?: unknown;
  }) {
    const cache = {
      getJson: jest
        .fn()
        .mockResolvedValue(
          options?.storedProposal !== undefined
            ? options.storedProposal
            : null,
        ),
      setJson: jest.fn().mockResolvedValue(undefined),
      setJsonNx: jest.fn().mockResolvedValue(true),
      takeJsonIf: jest.fn().mockResolvedValue(options?.storedClaim ?? null),
      getDelAndSetJson: jest.fn().mockResolvedValue(
        options?.consumeResult !== undefined
          ? options.consumeResult
          : (options?.storedProposal ?? null),
      ),
    } as unknown as CacheService;
    const prisma = {
      deviceSession: {
        create: options?.createError
          ? jest.fn().mockRejectedValue(options.createError)
          : jest
              .fn()
              .mockResolvedValue({ id: "session-1", userId: "user-1" }),
        delete: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(options?.session ?? null),
        findFirst: jest.fn().mockResolvedValue(options?.session ?? null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaService;
    return { service: new AppAuthService(prisma, cache), cache, prisma };
  }

  describe("normalizeDeviceCode", () => {
    it.each([
      ["DOK-482193", "482193"],
      ["dok-482193", "482193"],
      ["dok 482193", "482193"],
      ["  482193  ", "482193"],
    ])("normalizes %p to %p", (raw, expected) => {
      expect(AppAuthService.normalizeDeviceCode(raw)).toBe(expected);
    });

    it.each([["", "ABCDEF", "DOK-12345", "DOK-1234567", "DOK-12AB56"]])(
      "rejects %p",
      (raw) => {
        expect(AppAuthService.normalizeDeviceCode(raw)).toBeNull();
      },
    );
  });

  describe("proposeDeviceCode", () => {
    it("stores deviceName + secret hash (never the secret) with a 60s TTL, first writer wins", async () => {
      const { service, cache } = buildService();
      await expect(
        service.proposeDeviceCode("482193", "MacBook Pro", SECRET),
      ).resolves.toBe(true);
      expect(cache.setJsonNx).toHaveBeenCalledWith(
        "app_pair_device:482193",
        { deviceName: "MacBook Pro", secretHash: SECRET_HASH },
        60,
      );
    });

    it("returns false on collision instead of overwriting the live proposal", async () => {
      const { service, cache } = buildService();
      (cache.setJsonNx as jest.Mock).mockResolvedValue(false);
      await expect(
        service.proposeDeviceCode("482193", "Attacker Mac", "b".repeat(64)),
      ).resolves.toBe(false);
    });

    it("strips newlines from the device name (log/message forging)", async () => {
      const { service, cache } = buildService();
      await service.proposeDeviceCode(
        "482193",
        "MacBook\nINFO: paired attacker device",
        SECRET,
      );
      expect(cache.setJsonNx).toHaveBeenCalledWith(
        "app_pair_device:482193",
        expect.objectContaining({
          deviceName: "MacBook INFO: paired attacker device",
        }),
        60,
      );
    });
  });

  describe("claimDeviceCode", () => {
    it("peeks the proposal, mints a session, then atomically consumes the code and stashes the token", async () => {
      const { service, cache, prisma } = buildService({
        storedProposal: { deviceName: "MacBook Pro", secretHash: SECRET_HASH },
      });
      const result = await service.claimDeviceCode("482193", "user-1");
      expect(result).toEqual({ deviceName: "MacBook Pro", sessionId: "session-1" });

      // Peek first — the code is only consumed after the DB insert succeeds.
      expect(cache.getJson).toHaveBeenCalledWith("app_pair_device:482193");
      // Single atomic consume+stash — no crash window between GETDEL and
      // the claim write where the code would burn with no claim.
      expect(cache.getDelAndSetJson).toHaveBeenCalledWith(
        "app_pair_device:482193",
        "app_pair_claim:482193",
        expect.objectContaining({
          sessionId: "session-1",
          userId: "user-1",
          secretHash: SECRET_HASH,
        }),
        60,
      );
      expect(cache.getDelAndSetJson).toHaveBeenCalledTimes(1);
      expect(
        (cache.getJson as jest.Mock).mock.invocationCallOrder[0],
      ).toBeLessThan(
        (prisma.deviceSession.create as jest.Mock).mock.invocationCallOrder[0]!,
      );
      expect(
        (prisma.deviceSession.create as jest.Mock).mock.invocationCallOrder[0],
      ).toBeLessThan(
        (cache.getDelAndSetJson as jest.Mock).mock.invocationCallOrder[0]!,
      );

      // The DB receives the token hash (never the raw token) plus an expiry.
      const data = (prisma.deviceSession.create as jest.Mock).mock
        .calls[0][0].data;
      expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(data.userId).toBe("user-1");
      expect(data.deviceName).toBe("MacBook Pro");
      expect(data.expiresAt).toBeInstanceOf(Date);
      expect(data.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 179 * 86400_000,
      );

      // The stashed claim carries the token for the poll — the chat reply
      // must not.
      const claim = (cache.getDelAndSetJson as jest.Mock).mock.calls[0][2];
      expect(claim.token.length).toBeGreaterThanOrEqual(20);
    });

    it("returns null for an unknown, expired or already-used code", async () => {
      const { service, cache, prisma } = buildService({ storedProposal: null });
      await expect(service.claimDeviceCode("000000", "user-1")).resolves.toBeNull();
      expect(prisma.deviceSession.create).not.toHaveBeenCalled();
      expect(cache.getDelAndSetJson).not.toHaveBeenCalled();
    });

    it("keeps the code usable when the DB insert fails (mint-before-consume)", async () => {
      const { service, cache, prisma } = buildService({
        storedProposal: { deviceName: "MacBook Pro", secretHash: SECRET_HASH },
        createError: new Error("DB down"),
      });
      await expect(service.claimDeviceCode("482193", "user-1")).rejects.toThrow(
        "DB down",
      );
      // The proposal was only peeked, never consumed — the user retries with
      // the same code instead of generating a new one.
      expect(cache.getDelAndSetJson).not.toHaveBeenCalled();
      expect(prisma.deviceSession.create).toHaveBeenCalledTimes(1);
    });

    it("revokes the minted session and returns null when the consume race is lost", async () => {
      const { service, prisma } = buildService({
        storedProposal: { deviceName: "MacBook Pro", secretHash: SECRET_HASH },
        consumeResult: null,
      });
      await expect(
        service.claimDeviceCode("482193", "user-1"),
      ).resolves.toBeNull();
      // No orphan session survives the lost race.
      expect(prisma.deviceSession.delete).toHaveBeenCalledWith({
        where: { id: "session-1" },
      });
    });
  });

  describe("pollDeviceClaim", () => {
    const claim = {
      token: "tok",
      sessionId: "session-1",
      userId: "user-1",
      secretHash: SECRET_HASH,
    };

    it("returns the token once with the right secret via atomic compare-and-consume", async () => {
      const { service, cache } = buildService({ storedClaim: claim });
      const result = await service.pollDeviceClaim("482193", SECRET);
      expect(result).toEqual({
        claimed: true,
        token: "tok",
        sessionId: "session-1",
        userId: "user-1",
      });
      // Single atomic consume — no separate GET + DEL round trips whose
      // interleaving would let two concurrent polls both win.
      expect(cache.takeJsonIf).toHaveBeenCalledWith(
        "app_pair_claim:482193",
        "secretHash",
        SECRET_HASH,
      );
      expect(cache.takeJsonIf).toHaveBeenCalledTimes(1);
    });

    it("reads as not-claimed with a wrong secret and keeps the claim", async () => {
      const { service, cache } = buildService({ storedClaim: null });
      await expect(
        service.pollDeviceClaim("482193", "b".repeat(64)),
      ).resolves.toEqual({ claimed: false });
      // Mismatch (like a missing key) resolves to null — the key survives
      // for the rightful owner instead of being burned by the probe.
      expect(cache.takeJsonIf).toHaveBeenCalledWith(
        "app_pair_claim:482193",
        "secretHash",
        expect.any(String),
      );
    });

    it("reads as not-claimed when nothing was claimed yet", async () => {
      const { service } = buildService({ storedClaim: null });
      await expect(service.pollDeviceClaim("482193", SECRET)).resolves.toEqual({
        claimed: false,
      });
    });
  });

  describe("validateSession", () => {
    const liveSession = {
      id: "s-1",
      userId: "user-1",
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86400_000),
    };

    it("returns null for a malformed/short token without hitting the DB", async () => {
      const { service, prisma } = buildService();
      expect(await service.validateSession("short")).toBeNull();
      expect(prisma.deviceSession.findUnique).not.toHaveBeenCalled();
    });

    it("returns the session for a live token and refreshes lastSeenAt", async () => {
      const { service, prisma } = buildService({ session: liveSession });
      const session = await service.validateSession("a".repeat(43));
      expect(session).toEqual({ sessionId: "s-1", userId: "user-1" });
      expect(prisma.deviceSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "s-1" } }),
      );
    });

    it("returns null for a revoked session", async () => {
      const { service } = buildService({
        session: { id: "s-1", userId: "user-1", revokedAt: new Date() },
      });
      expect(await service.validateSession("a".repeat(43))).toBeNull();
    });

    it("returns null for an expired session even when not revoked", async () => {
      const { service, prisma } = buildService({
        session: {
          id: "s-1",
          userId: "user-1",
          revokedAt: null,
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      expect(await service.validateSession("a".repeat(43))).toBeNull();
      expect(prisma.deviceSession.update).not.toHaveBeenCalled();
    });

    it("returns null for an unknown token", async () => {
      const { service } = buildService({ session: null });
      expect(await service.validateSession("a".repeat(43))).toBeNull();
    });
  });

  describe("rotateSession", () => {
    const liveSession = {
      id: "s-1",
      userId: "user-1",
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86400_000),
    };

    it("mints a fresh token + expiry scoped to the owner's live session", async () => {
      const { service, prisma } = buildService({ session: liveSession });
      const rotated = await service.rotateSession("s-1", "user-1");
      expect(rotated).not.toBeNull();
      expect(rotated!.sessionId).toBe("s-1");
      expect(rotated!.token.length).toBeGreaterThanOrEqual(20);
      expect(rotated!.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 179 * 86400_000,
      );
      // Old token dies with the hash overwrite; scope binds id + owner.
      expect(prisma.deviceSession.findFirst).toHaveBeenCalledWith({
        where: { id: "s-1", userId: "user-1", revokedAt: null },
      });
      const data = (prisma.deviceSession.update as jest.Mock).mock
        .calls[0][0].data;
      expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(data.expiresAt).toEqual(rotated!.expiresAt);
    });

    it("returns null for a revoked or missing session without writing", async () => {
      const { service, prisma } = buildService({ session: null });
      await expect(service.rotateSession("s-1", "user-1")).resolves.toBeNull();
      expect(prisma.deviceSession.update).not.toHaveBeenCalled();
    });

    it("returns null for an expired session so a stolen old token cannot be laundered", async () => {
      const { service, prisma } = buildService({
        session: {
          ...liveSession,
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      await expect(service.rotateSession("s-1", "user-1")).resolves.toBeNull();
      expect(prisma.deviceSession.update).not.toHaveBeenCalled();
    });
  });

  describe("revokeSession", () => {
    it("scopes revocation to the owner via updateMany", async () => {
      const { service, prisma } = buildService();
      (prisma.deviceSession.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      expect(await service.revokeSession("s-1", "user-1")).toBe(true);
      expect(prisma.deviceSession.updateMany).toHaveBeenCalledWith({
        where: { id: "s-1", userId: "user-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it("returns false when nothing was revoked (not found / already revoked)", async () => {
      const { service, prisma } = buildService();
      (prisma.deviceSession.updateMany as jest.Mock).mockResolvedValue({
        count: 0,
      });
      expect(await service.revokeSession("s-1", "user-1")).toBe(false);
    });
  });
});
