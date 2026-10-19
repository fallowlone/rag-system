import { PdfService } from "./pdf.service";
import { EventEmitter } from "events";

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

import { spawn } from "child_process";

describe("PdfService.generateLetterPdf timeout", () => {
  function fakeProcess() {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: jest.Mock; end: jest.Mock };
      kill: jest.Mock;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: jest.fn(), end: jest.fn() };
    proc.kill = jest.fn();
    return proc;
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("kills the process and rejects when generation exceeds the timeout", async () => {
    const proc = fakeProcess();
    (spawn as jest.Mock).mockReturnValue(proc);

    const service = new PdfService();
    const promise = service.generateLetterPdf("some letter text");
    // The concurrency limiter starts the spawn on a microtask — flush
    // before driving the fake process.
    await Promise.resolve();
    const assertion = expect(promise).rejects.toThrow("PDF generation timed out");

    jest.advanceTimersByTime(30_001);

    await assertion;
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("resolves normally when the process closes before the timeout", async () => {
    const proc = fakeProcess();
    (spawn as jest.Mock).mockReturnValue(proc);

    const service = new PdfService();
    const promise = service.generateLetterPdf("some letter text");
    await Promise.resolve();

    proc.stdout.emit("data", Buffer.from("%PDF-1.4 fake pdf bytes"));
    proc.emit("close", 0);

    const result = await promise;
    expect(result).toEqual(Buffer.from("%PDF-1.4 fake pdf bytes"));
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("caps concurrent generations at two (third waits for a slot)", async () => {
    const procs = [fakeProcess(), fakeProcess(), fakeProcess()];
    (spawn as jest.Mock)
      .mockReturnValueOnce(procs[0])
      .mockReturnValueOnce(procs[1])
      .mockReturnValueOnce(procs[2]);

    const service = new PdfService();
    const first = service.generateLetterPdf("letter 1");
    const second = service.generateLetterPdf("letter 2");
    const third = service.generateLetterPdf("letter 3");
    await Promise.resolve();
    await Promise.resolve();

    expect(spawn).toHaveBeenCalledTimes(2);

    procs[0]!.stdout.emit("data", Buffer.from("pdf-1"));
    procs[0]!.emit("close", 0);
    await first;
    // A freed slot starts the queued generation.
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(3);

    procs[1]!.stdout.emit("data", Buffer.from("pdf-2"));
    procs[1]!.emit("close", 0);
    procs[2]!.stdout.emit("data", Buffer.from("pdf-3"));
    procs[2]!.emit("close", 0);
    await expect(second).resolves.toEqual(Buffer.from("pdf-2"));
    await expect(third).resolves.toEqual(Buffer.from("pdf-3"));
  });
});
