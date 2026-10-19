-- Device sessions expire (180 days): bounds stolen-token lifetime and reaps
-- pairing-crash orphans whose raw token was never delivered to the device.
-- Existing rows expire 180 days after creation, matching the mint rule for
-- new rows (DeviceSessionTtlDays in app-auth.service.ts).
ALTER TABLE "DeviceSession" ADD COLUMN "expiresAt" TIMESTAMP(3);
UPDATE "DeviceSession" SET "expiresAt" = "createdAt" + INTERVAL '180 days' WHERE "expiresAt" IS NULL;
ALTER TABLE "DeviceSession" ALTER COLUMN "expiresAt" SET NOT NULL;
