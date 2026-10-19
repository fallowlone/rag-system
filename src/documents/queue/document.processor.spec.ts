import { Job, UnrecoverableError } from "bullmq";
import { DocumentProcessor } from "./document.processor";
import { DocumentJobNotifier } from "./document-job-notifier";
import { DocumentJobPayload } from "./document-job.types";

function buildProcessor() {
  const notifyDocumentJobFailed = jest.fn().mockResolvedValue(undefined);
  const notifier = {
    processDocumentJob: jest.fn().mockResolvedValue(undefined),
    notifyDocumentJobFailed,
  } as unknown as DocumentJobNotifier;
  const processor = new DocumentProcessor(notifier);
  return { processor, notifyDocumentJobFailed };
}

function makeJob(attemptsMade: number, attempts = 3): Job<DocumentJobPayload> {
  return {
    id: "job-1",
    opts: { attempts },
    attemptsMade,
    data: {
      userId: "42",
      chatId: "42",
      fileId: "file-1",
      fileName: "vertrag.pdf",
      caption: null,
      lang: "de",
      statusMsgId: 100,
      sourceHash: "abc",
      category: "jobcenter",
    },
  } as Job<DocumentJobPayload>;
}

describe("DocumentProcessor.onFailed terminal notification", () => {
  it("notifies the user immediately on UnrecoverableError, even on the first attempt", () => {
    const { processor, notifyDocumentJobFailed } = buildProcessor();
    const job = makeJob(0);

    processor.onFailed(job, new UnrecoverableError("file gone"));

    expect(notifyDocumentJobFailed).toHaveBeenCalledTimes(1);
    expect(notifyDocumentJobFailed).toHaveBeenCalledWith(
      job.data,
      expect.any(UnrecoverableError),
    );
  });

  it("stays silent on a retryable mid-run failure", () => {
    const { processor, notifyDocumentJobFailed } = buildProcessor();

    processor.onFailed(makeJob(0), new Error("transient LLM error"));

    expect(notifyDocumentJobFailed).not.toHaveBeenCalled();
  });

  it("notifies the user when attempts are exhausted", () => {
    const { processor, notifyDocumentJobFailed } = buildProcessor();

    processor.onFailed(makeJob(3), new Error("still failing"));

    expect(notifyDocumentJobFailed).toHaveBeenCalledTimes(1);
  });

  it("ignores a missing job", () => {
    const { processor, notifyDocumentJobFailed } = buildProcessor();

    expect(() =>
      processor.onFailed(undefined, new Error("x")),
    ).not.toThrow();
    expect(notifyDocumentJobFailed).not.toHaveBeenCalled();
  });
});
