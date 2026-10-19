import { AppHintsService } from "./app-hints.service";
import { PrismaService } from "../prisma/prisma.service";

const NOW = new Date("2026-09-05T12:00:00Z");

function doc(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    fileName: "bescheid.pdf",
    title: "Bewilligungsbescheid",
    category: "jobcenter",
    isActive: true,
    docDate: new Date("2026-09-01T00:00:00Z"),
    expiryDate: null,
    appSource: true,
    ...overrides,
  };
}

function deadline(overrides: Record<string, unknown> = {}) {
  return {
    label: "Widerspruch einlegen",
    deadlineDate: new Date("2026-10-01T00:00:00Z"),
    completedAt: null,
    sourceId: "doc-1",
    ...overrides,
  };
}

describe("AppHintsService", () => {
  function buildService(options?: {
    docs?: ReturnType<typeof doc>[];
    deadlines?: ReturnType<typeof deadline>[];
    insights?: { documentId: string }[];
  }) {
    const prisma = {
      userDocument: {
        findMany: jest.fn().mockResolvedValue(options?.docs ?? []),
      },
      userDeadline: {
        findMany: jest.fn().mockResolvedValue(options?.deadlines ?? []),
      },
      documentInsight: {
        findMany: jest.fn().mockResolvedValue(options?.insights ?? []),
      },
    } as unknown as PrismaService;
    const service = new AppHintsService(prisma);
    return { service, prisma };
  }

  it("returns no hints for an empty account", async () => {
    const { service } = buildService();
    await expect(service.hints("user-1", NOW)).resolves.toEqual([]);
  });

  it("flags a jobcenter letter with a date but no deadlines (Widerspruch check)", async () => {
    const { service } = buildService({
      docs: [doc()],
      insights: [{ documentId: "doc-1" }],
    });

    const hints = await service.hints("user-1", NOW);

    expect(hints).toHaveLength(1);
    expect(hints[0]).toEqual(
      expect.objectContaining({
        kind: "missing_widerspruch_deadline",
        severity: "high",
        documentIds: ["doc-1"],
      }),
    );
    // docDate 2026-09-01 + 1 month ≈ 2026-10-01
    expect(hints[0]?.body).toContain("2026-10-01");
  });

  it("warns stronger when the computed Widerspruchsfrist already passed", async () => {
    const { service } = buildService({
      docs: [doc({ docDate: new Date("2026-06-01T00:00:00Z") })],
      insights: [{ documentId: "doc-1" }],
    });

    const hints = await service.hints("user-1", NOW);

    expect(hints).toHaveLength(1);
    expect(hints[0]?.title).toContain("verstrichen");
  });

  it("stays silent when the document already has a deadline row", async () => {
    const { service } = buildService({
      docs: [doc()],
      deadlines: [deadline()],
      insights: [{ documentId: "doc-1" }],
    });

    await expect(service.hints("user-1", NOW)).resolves.toEqual([]);
  });

  it("never suggests Widerspruch for private-law categories", async () => {
    const { service } = buildService({
      docs: [
        doc({ id: "doc-m", category: "mietvertrag" }),
        doc({ id: "doc-b", category: "bank" }),
      ],
      insights: [{ documentId: "doc-m" }, { documentId: "doc-b" }],
    });

    const hints = await service.hints("user-1", NOW);

    expect(
      hints.filter((h) => h.kind === "missing_widerspruch_deadline"),
    ).toEqual([]);
  });

  it("flags an expired document that is still marked active", async () => {
    const { service } = buildService({
      docs: [
        doc({ expiryDate: new Date("2026-08-01T00:00:00Z") }),
      ],
      deadlines: [deadline()],
      insights: [{ documentId: "doc-1" }],
    });

    const hints = await service.hints("user-1", NOW);

    expect(hints).toEqual([
      expect.objectContaining({
        kind: "expired_still_active",
        severity: "medium",
        documentIds: ["doc-1"],
      }),
    ]);
  });

  it("clusters open deadlines within three days", async () => {
    const { service } = buildService({
      docs: [doc({ category: "other" })],
      deadlines: [
        deadline({ label: "A", deadlineDate: new Date("2026-09-10T00:00:00Z") }),
        deadline({ label: "B", deadlineDate: new Date("2026-09-12T00:00:00Z") }),
        deadline({ label: "C", deadlineDate: new Date("2026-10-20T00:00:00Z") }),
      ],
      insights: [{ documentId: "doc-1" }],
    });

    const hints = await service.hints("user-1", NOW);

    const clusters = hints.filter((h) => h.kind === "deadline_cluster");
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.title).toContain("2 Fristen");
    expect(clusters[0]?.body).toContain("A (2026-09-10)");
    expect(clusters[0]?.body).toContain("B (2026-09-12)");
    expect(clusters[0]?.body).not.toContain("C (2026-10-20)");
    // Linked document ids drive the Fristen-Radar row badges (deduped).
    expect(clusters[0]?.documentIds).toEqual(["doc-1"]);
  });

  it("chains linked windows into one cluster instead of dropping the B–C collision", async () => {
    // A=day 8, B=day 10, C=day 12: the disjoint window [8,11] consumes {A,B}
    // and strands C alone — the B–C collision (gap 2d) must still surface.
    const { service } = buildService({
      docs: [doc({ category: "other" })],
      deadlines: [
        deadline({ label: "A", deadlineDate: new Date("2026-09-08T00:00:00Z") }),
        deadline({ label: "B", deadlineDate: new Date("2026-09-10T00:00:00Z") }),
        deadline({ label: "C", deadlineDate: new Date("2026-09-12T00:00:00Z") }),
      ],
      insights: [{ documentId: "doc-1" }],
    });

    const hints = await service.hints("user-1", NOW);

    const clusters = hints.filter((h) => h.kind === "deadline_cluster");
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.title).toContain("3 Fristen");
    expect(clusters[0]?.body).toContain("C (2026-09-12)");
  });

  it("clamps the Widerspruchsfrist to February instead of rolling into March", async () => {
    const { service } = buildService({
      docs: [doc({ docDate: new Date("2026-01-31T00:00:00Z") })],
      insights: [{ documentId: "doc-1" }],
    });

    const hints = await service.hints("user-1", NOW);

    expect(hints).toHaveLength(1);
    expect(hints[0]?.body).toContain("2026-02-28");
    expect(hints[0]?.body).not.toContain("2026-03-03");
  });

  it("links cluster hints to each colliding document, skipping manual deadlines", async () => {    const { service } = buildService({
      docs: [doc({ category: "other" })],
      deadlines: [
        deadline({ label: "A", deadlineDate: new Date("2026-09-10T00:00:00Z"), sourceId: "doc-1" }),
        deadline({ label: "B", deadlineDate: new Date("2026-09-11T00:00:00Z"), sourceId: "doc-2" }),
        deadline({ label: "M", deadlineDate: new Date("2026-09-12T00:00:00Z"), sourceId: null }),
      ],
      insights: [{ documentId: "doc-1" }],
    });

    const hints = await service.hints("user-1", NOW);

    const clusters = hints.filter((h) => h.kind === "deadline_cluster");
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.documentIds).toEqual(["doc-1", "doc-2"]);
  });

  it("ignores completed and past deadlines for clustering", async () => {
    const { service } = buildService({
      docs: [doc({ category: "other" })],
      deadlines: [
        deadline({
          label: "Done",
          deadlineDate: new Date("2026-09-10T00:00:00Z"),
          completedAt: new Date("2026-09-06T00:00:00Z"),
        }),
        deadline({
          label: "Past",
          deadlineDate: new Date("2026-09-01T00:00:00Z"),
        }),
      ],
      insights: [{ documentId: "doc-1" }],
    });

    const hints = await service.hints("user-1", NOW);

    expect(hints.filter((h) => h.kind === "deadline_cluster")).toEqual([]);
  });

  it("aggregates documents without analysis into one hint (app path only)", async () => {
    const { service } = buildService({
      docs: [
        doc({ id: "doc-1", category: "other" }),
        doc({ id: "doc-2", category: "other" }),
        // Telegram-path document: no analyzable extraction, never flagged
        doc({ id: "doc-3", category: "other", appSource: false }),
      ],
    });

    const hints = await service.hints("user-1", NOW);

    expect(hints).toEqual([
      expect.objectContaining({
        kind: "analysis_missing",
        severity: "low",
        documentIds: ["doc-1", "doc-2"],
      }),
    ]);
  });

  it("scopes every query to the user", async () => {
    const { service, prisma } = buildService();

    await service.hints("user-42", NOW);

    // The invariant is the IDOR guard — every query carries the owner —
    // not the exact filter shape, which legitimately grew bounds and
    // date/id narrowing.
    const allCalls = [
      ...(prisma.userDocument.findMany as jest.Mock).mock.calls,
      ...(prisma.userDeadline.findMany as jest.Mock).mock.calls,
      ...(prisma.documentInsight.findMany as jest.Mock).mock.calls,
    ];
    expect(allCalls.length).toBeGreaterThan(0);
    for (const call of allCalls) {
      expect(call[0].where).toEqual(
        expect.objectContaining({ userId: "user-42" }),
      );
    }
  });

  it("bounds every query instead of scanning the account's whole history", async () => {
    const { service, prisma } = buildService();

    await service.hints("user-42", NOW);

    // These run on every hints request; unbounded `where: { userId }` made
    // their cost grow with the account's lifetime rather than with what the
    // hints can actually report on.
    for (const call of [
      ...(prisma.userDocument.findMany as jest.Mock).mock.calls,
      ...(prisma.userDeadline.findMany as jest.Mock).mock.calls,
      ...(prisma.documentInsight.findMany as jest.Mock).mock.calls,
    ]) {
      expect(typeof call[0].take).toBe("number");
      expect(call[0].take).toBeGreaterThan(0);
    }
  });
});
