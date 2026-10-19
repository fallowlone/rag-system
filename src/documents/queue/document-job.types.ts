export const DOCUMENT_JOB_QUEUE = "document-jobs";
export const DOCUMENT_JOB_NAME = "process";

export interface DocumentJobPayload {
  userId: string;
  chatId: string;
  fileId: string;
  fileName: string | null;
  caption: string | null;
  lang: string;
  statusMsgId: number | null;
  sourceHash: string | null;
  category: string | null;
}
