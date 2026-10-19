import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  DocumentRow,
  FolderScan,
  ModelStatus,
  RemoteData,
  RemoteHint,
  SuggestedTask,
  SyncReport,
  TaskStatus,
} from "./types";

/** Typed wrappers around every dokumente-core IPC command. */

export const ipc = {
  ingestDocument: (path: string) =>
    invoke<{ duplicate: boolean; document: DocumentRow | null }>(
      "ingest_document",
      { path },
    ),

  listDocuments: () => invoke<DocumentRow[]>("list_documents"),

  listFolderFiles: (path: string) =>
    invoke<FolderScan>("list_folder_files", { path }),

  extractDocument: (documentId: string) =>
    invoke<{ extracted: boolean }>("extract_document", { documentId }),

  /** Deletes locally AND server-side; rejects (keeping both copies) when the
   *  server copy cannot be removed. `remoteDeleted` is false for documents
   *  that never synced. */
  deleteDocument: (documentId: string, baseUrl?: string) =>
    invoke<{ deleted: boolean; remoteDeleted: boolean }>("delete_document", {
      documentId,
      baseUrl,
    }),

  pairPropose: (deviceName: string, baseUrl?: string) =>
    invoke<{
      code: string;
      displayCode: string;
      secret: string;
      expiresIn: number;
    }>("pair_propose", { deviceName, baseUrl }),

  pairPoll: (
    code: string,
    secret: string,
    deviceName: string,
    baseUrl?: string,
  ) =>
    invoke<{ claimed: boolean }>("pair_poll", {
      code,
      secret,
      deviceName,
      baseUrl,
    }),

  unpairDevice: (baseUrl?: string) =>
    invoke<{ unpaired: boolean }>("unpair_device", { baseUrl }),

  pairingDetails: () =>
    invoke<{
      paired: boolean;
      deviceName: string | null;
      syncUploadEnabled: boolean;
      serverScanEnabled: boolean;
    }>("pairing_details"),

  setSyncUpload: (enabled: boolean) =>
    invoke<{ syncUploadEnabled: boolean }>("set_sync_upload", { enabled }),

  setServerScan: (enabled: boolean) =>
    invoke<{ serverScanEnabled: boolean }>("set_server_scan", { enabled }),

  scanImage: (documentId: string, language?: string) =>
    invoke<{ text: string }>("scan_image", { documentId, language }),

  botUsername: (baseUrl?: string) =>
    invoke<{ botUsername: string | null }>("bot_username", { baseUrl }),

  translateText: (text: string, from: string, to: string) =>
    invoke<{ text: string }>("translate_text", { text, from, to }),

  syncNow: (baseUrl?: string) =>
    invoke<SyncReport>("sync_now", { baseUrl }),

  syncPull: (baseUrl?: string) =>
    invoke<{ data: RemoteData; resynced: boolean }>("sync_pull", { baseUrl }),

  requeueFailedDocument: (documentId: string) =>
    invoke<{ requeued: number }>("requeue_failed_document", {
      documentId,
    }),

  remoteData: () => invoke<RemoteData>("remote_data"),

  pairedStatus: () => invoke<{ paired: boolean }>("paired_status"),

  quarantineStatus: () => invoke<string | null>("quarantine_status"),

  modelStatus: (small?: boolean) =>
    invoke<ModelStatus>("model_status", { small }),

  downloadModel: (
    small: boolean | undefined,
    onProgress: (downloaded: number, total: number | null) => void,
  ) => {
    const channel = new Channel<{ downloaded: number; total: number | null }>();
    channel.onmessage = (msg) => onProgress(msg.downloaded, msg.total);
    return invoke<{ status: string; sha256?: string }>("download_model", {
      small,
      onProgress: channel,
    });
  },

  listSuggestedTasks: () => invoke<SuggestedTask[]>("list_suggested_tasks"),

  confirmSuggestedTask: (id: number, baseUrl?: string) =>
    invoke<{ confirmed: boolean; taskId: number }>("confirm_suggested_task", {
      id,
      baseUrl,
    }),

  dismissSuggestedTask: (id: number) =>
    invoke<{ dismissed: boolean }>("dismiss_suggested_task", { id }),

  chatAsk: (question: string, language?: string, baseUrl?: string) =>
    invoke<string>("chat_ask", { question, language, baseUrl }),

  askDocument: (
    documentId: string,
    question: string,
    language?: string,
    baseUrl?: string,
  ) =>
    invoke<string>("ask_document", {
      documentId,
      question,
      language,
      baseUrl,
    }),

  fetchHints: (baseUrl?: string) =>
    invoke<RemoteHint[]>("fetch_hints", { baseUrl }),

  completeDeadline: (deadlineId: string, completed: boolean, baseUrl?: string) =>
    invoke<void>("complete_deadline", { deadlineId, completed, baseUrl }),

  updateTaskStatus: (taskId: string, status: TaskStatus, baseUrl?: string) =>
    invoke<void>("update_task_status", { taskId, status, baseUrl }),
};
