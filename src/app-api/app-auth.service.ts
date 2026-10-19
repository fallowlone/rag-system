import { Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../cache/cache.service";
import {
  AppPairResult,
  AppSession,
  DevicePairClaimResult,
  DevicePairPollResult,
  DeviceSessionInfo,
} from "./app-api.types";

const DEVICE_PAIRING_CODE_TTL_SECONDS = 60;
const DEVICE_PAIRING_CLAIM_TTL_SECONDS = 60;
const DEVICE_TOKEN_BYTES = 32;
// Device sessions live 180 days from mint/rotation, then must re-pair.
// Bounds stolen-token lifetime and reaps pairing-crash orphans whose raw
// token was never delivered (claimDeviceCode compensates the consume race,
// but a crash between mint and the atomic consume still leaves one row).
const DEVICE_SESSION_TTL_MS = 180 * 86400_000;

interface DevicePairingProposal {
  deviceName: string;
  secretHash: string;
}

interface DevicePairingClaim {
  token: string;
  sessionId: string;
  userId: string;
  secretHash: string;
}

function deviceProposalKey(code: string): string {
  return `app_pair_device:${code}`;
}

function deviceClaimKey(code: string): string {
  return `app_pair_claim:${code}`;
}

/**
 * sha256 of the raw device token. The token is 256 random bits, so a plain
 * (unsalted) hash is safe against brute force — the same construction GitHub
 * uses for PATs — and keeps the hash indexable for O(1) session lookup.
 * Salted slow hashing (scrypt) would prevent indexed lookup and adds nothing
 * against an infeasible 2^256 keyspace.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Device pairing for the macOS companion app (reverse flow).
 *
 * The device generates a DOK-###### code + a 256-bit proposal secret and
 * registers both via POST /app/v1/auth/pair-propose (unauthenticated — the
 * device has no token yet). The user sends the code to the Telegram bot via
 * `/pair DOK-######`; the bot claims it for their account and stashes the
 * device token in Redis. The device polls POST /app/v1/auth/pair-status with
 * code + secret until the claim appears. Everything is TTL 60s and single-use
 * via GETDEL/del.
 *
 * Only the sha256 of the proposal secret is stored, and the raw device token
 * exists only in the Redis claim + the HTTP poll response; the DB stores its
 * sha256 hash. Sessions are revocable and expire 180 days after mint (the
 * device rotates before then); expiry also reaps pairing-crash orphans.
 */
@Injectable()
export class AppAuthService {
  private readonly logger = new Logger(AppAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Normalizes a user-supplied pairing code ("DOK-482193", "dok 482193",
   * "482193") to bare digits, or null when it cannot be a device code.
   */
  static normalizeDeviceCode(raw: string): string | null {
    const digits = raw.trim().toUpperCase().replace(/^DOK[\s-]?/, "");
    return /^\d{6}$/.test(digits) ? digits : null;
  }

  /**
   * Called by the device (unauthenticated). Registers the device-generated
   * code so the bot can later claim it. First writer wins (SET NX): a code
   * already proposed by another device reads as a collision, never as a
   * hijack — the caller retries with a fresh code. Returns false on
   * collision.
   */
  async proposeDeviceCode(
    code: string,
    deviceName: string,
    secret: string,
  ): Promise<boolean> {
    // deviceName flows into server logs and the Telegram pairing reply:
    // strip CR/LF so a hostile name cannot forge log lines or message
    // layout (the Zod schema already bounds length, not newlines).
    const safeName = deviceName.replace(/[\r\n]+/g, " ").trim();
    const registered = await this.cache.setJsonNx(
      deviceProposalKey(code),
      {
        deviceName: safeName,
        secretHash: hashToken(secret),
      } satisfies DevicePairingProposal,
      DEVICE_PAIRING_CODE_TTL_SECONDS,
    );
    if (!registered) {
      this.logger.warn(
        `Device pairing proposal rejected: code already proposed (valid ${DEVICE_PAIRING_CODE_TTL_SECONDS}s)`,
      );
      return false;
    }
    this.logger.log(
      `Device pairing proposed for "${safeName}" (valid ${DEVICE_PAIRING_CODE_TTL_SECONDS}s)`,
    );
    return true;
  }

  /**
   * Called by the Telegram /pair command with the user's code. Peeks the
   * proposal, mints the DB session FIRST, then consumes the proposal and
   * stashes the minted token for the device poll in ONE atomic Lua script.
   * Mint-first matters: if the DB insert fails, the proposal is untouched
   * and the user retries with the same code instead of generating a new one.
   * The atomic consume still makes the code single-use — a lost consume race
   * (two claimants, one code) revokes the loser's just-minted session so no
   * usable orphan session survives (a crash between mint and the script can
   * still leave a row, but it expires via expiresAt and its token was never
   * delivered). The token itself is NEVER returned here — it must not leak
   * into the chat. Returns null when the code is unknown, expired or reused.
   */
  async claimDeviceCode(
    code: string,
    userId: string,
  ): Promise<DevicePairClaimResult | null> {
    const proposal = await this.cache.getJson<DevicePairingProposal>(
      deviceProposalKey(code),
    );
    if (!proposal?.deviceName || !proposal.secretHash) {
      this.logger.warn("Device pairing claim rejected: unknown, expired or reused code");
      return null;
    }

    const { token, sessionId } = await this.mintDeviceSession(
      userId,
      proposal.deviceName,
    );
    const consumed =
      await this.cache.getDelAndSetJson<DevicePairingProposal>(
        deviceProposalKey(code),
        deviceClaimKey(code),
        {
          token,
          sessionId,
          userId,
          secretHash: proposal.secretHash,
        } satisfies DevicePairingClaim,
        DEVICE_PAIRING_CLAIM_TTL_SECONDS,
      );
    if (!consumed) {
      // Lost the consume race — another claimant took the code. Revoke the
      // session minted above so it cannot linger as an orphan.
      await this.prisma.deviceSession
        .delete({ where: { id: sessionId } })
        .catch((err: unknown) => {
          this.logger.warn(
            `Pairing race cleanup failed for session ${sessionId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      this.logger.warn("Device pairing claim rejected: unknown, expired or reused code");
      return null;
    }
    this.logger.log(
      `Device "${proposal.deviceName}" paired for user ${userId} (session ${sessionId})`,
    );
    return { deviceName: proposal.deviceName, sessionId };
  }

  /**
   * Called by the device poll. A wrong or unknown code/secret reads as
   * "not claimed" — never as an error — so probes learn nothing, and a
   * wrong secret can neither steal nor destroy the claim. Consumption is
   * atomic (Lua compare-and-delete on the secret hash): concurrent polls
   * with the right secret resolve to exactly one winner, so a replayed poll
   * can never re-mint.
   */
  async pollDeviceClaim(
    code: string,
    secret: string,
  ): Promise<DevicePairPollResult> {
    const claim = await this.cache.takeJsonIf<DevicePairingClaim>(
      deviceClaimKey(code),
      "secretHash",
      hashToken(secret),
    );
    if (!claim) {
      return { claimed: false };
    }
    return {
      claimed: true,
      token: claim.token,
      sessionId: claim.sessionId,
      userId: claim.userId,
    };
  }

  /**
   * Mints the long-lived device token + DB session. The raw token is returned
   * to the caller for delivery to the device; only its sha256 reaches the DB.
   */
  private async mintDeviceSession(
    userId: string,
    deviceName: string,
  ): Promise<AppPairResult> {
    const token = randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
    const session = await this.prisma.deviceSession.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        deviceName,
        expiresAt: new Date(Date.now() + DEVICE_SESSION_TTL_MS),
      },
    });
    return { token, sessionId: session.id, userId };
  }

  /** Returns the live session for a raw token, or null if unknown/revoked/expired. */
  async validateSession(token: string): Promise<AppSession | null> {
    if (token.length < 20) {
      // Cheap shape guard before hitting the DB with a guaranteed miss.
      return null;
    }
    const session = await this.prisma.deviceSession.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    // lastSeenAt is telemetry only — a failed update must never reject a valid
    // request.
    void this.prisma.deviceSession
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch((err: unknown) => {
        this.logger.warn(
          `lastSeenAt update failed for session ${session.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });

    return { sessionId: session.id, userId: session.userId };
  }

  async listSessions(userId: string): Promise<DeviceSessionInfo[]> {
    const sessions = await this.prisma.deviceSession.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        deviceName: true,
        createdAt: true,
        lastSeenAt: true,
        revokedAt: true,
        expiresAt: true,
      },
    });
    return sessions;
  }

  /**
   * Rotates one of the user's own live sessions: mints a fresh 256-bit token
   * (old token dies with the hash overwrite) and pushes expiry out another
   * full TTL. Scoped to (id, userId), live sessions only — revoked or
   * expired rows read as null so a stolen old token cannot be laundered into
   * a fresh one. Returns the raw token exactly once, like the pairing poll.
   */
  async rotateSession(
    sessionId: string,
    userId: string,
  ): Promise<{ token: string; sessionId: string; expiresAt: Date } | null> {
    const session = await this.prisma.deviceSession.findFirst({
      where: { id: sessionId, userId, revokedAt: null },
    });
    if (!session || session.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    const token = randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
    const expiresAt = new Date(Date.now() + DEVICE_SESSION_TTL_MS);
    await this.prisma.deviceSession.update({
      where: { id: session.id },
      data: { tokenHash: hashToken(token), expiresAt, lastSeenAt: new Date() },
    });
    this.logger.log(`Session ${session.id} rotated for user ${userId}`);
    return { token, sessionId: session.id, expiresAt };
  }

  /** Revokes one of the user's own sessions (scoped — no IDOR). */
  async revokeSession(sessionId: string, userId: string): Promise<boolean> {
    const result = await this.prisma.deviceSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count > 0) {
      this.logger.log(`Session ${sessionId} revoked for user ${userId}`);
    }
    return result.count > 0;
  }
}
