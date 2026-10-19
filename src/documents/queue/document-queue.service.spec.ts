import { Queue } from "bullmq";
import { DocumentQueueService } from "./document-queue.service";
import {
  DOCUMENT_JOB_NAME,
  DocumentJobPayload,
} from "./document-job.types";

function buildPayload(overrides: Partial<DocumentJobPayload> = {}): DocumentJobPayload {
  return {
    userId: "42",
    chatId: "42",
    fileId: "file-1",
    fileName: "vertrag.pdf",
    caption: null,
    lang: "de",
    statusMsgId: 100,
    sourceHash: "abc123",
    category: "jobcenter",
    ...overrides,
  };
}

describe("DocumentQueueService", () => {
  it("dedupes concurrent enqueues of the same (user, file) via deduplication id", async () => {
    const add = jest.fn().mockResolvedValue({ id: "job-1" });
    const service = new DocumentQueueService({ add } as unknown as Queue);

    await service.enqueue(buildPayload());

    expect(add).toHaveBeenCalledWith(
      DOCUMENT_JOB_NAME,
      expect.objectContaining({ userId: "42", sourceHash: "abc123" }),
      expect.objectContaining({
        attempts: 3,
        deduplication: { id: "doc:42:abc123" },
      }),
    );
  });

  it("falls back to fileId when sourceHash is not precomputed yet", async () => {
    const add = jest.fn().mockResolvedValue({ id: "job-2" });
    const service = new DocumentQueueService({ add } as unknown as Queue);

    await service.enqueue(buildPayload({ sourceHash: null, fileId: "file-9" }));

    expect(add).toHaveBeenCalledWith(
      DOCUMENT_JOB_NAME,
      expect.anything(),
      expect.objectContaining({
        deduplication: { id: "doc:42:file-9" },
      }),
    );
  });

  it("scopes the dedup id by user so two users uploading the same file do not collide", async () => {
    const add = jest.fn().mockResolvedValue({ id: "job-3" });
    const service = new DocumentQueueService({ add } as unknown as Queue);

    await service.enqueue(buildPayload({ userId: "77" }));

    expect(add).toHaveBeenCalledWith(
      DOCUMENT_JOB_NAME,
      expect.anything(),
      expect.objectContaining({
        deduplication: { id: "doc:77:abc123" },
      }),
    );
  });
});
