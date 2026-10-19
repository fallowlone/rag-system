import { BadRequestException } from "@nestjs/common";
import { AppDeadlinesController } from "./app-deadlines.controller";
import { DeadlineService } from "../deadlines/deadline.service";
import { AppAuthedRequest } from "./app-api.types";

describe("AppDeadlinesController", () => {
  function buildController(setDeadlineCompleted?: jest.Mock) {
    const deadlines = {
      setDeadlineCompleted:
        setDeadlineCompleted ?? jest.fn().mockResolvedValue(true),
    } as unknown as DeadlineService;
    const controller = new AppDeadlinesController(deadlines);
    const req = {
      appSession: { userId: "user-1" },
    } as unknown as AppAuthedRequest;
    return { controller, deadlines, req };
  }

  it("delegates a valid body to the owner-scoped service", async () => {
    const setDeadlineCompleted = jest.fn().mockResolvedValue(true);
    const { controller, req } = buildController(setDeadlineCompleted);

    const result = await controller.setCompleted(req, "dl-1", {
      completed: true,
    });

    expect(result).toEqual({ updated: true, completed: true });
    expect(setDeadlineCompleted).toHaveBeenCalledWith("user-1", "dl-1", true);
  });

  it("rejects a non-boolean body with 400", async () => {
    const setDeadlineCompleted = jest.fn();
    const { controller, req } = buildController(setDeadlineCompleted);

    await expect(
      controller.setCompleted(req, "dl-1", { completed: "yes" }),
    ).rejects.toThrow(BadRequestException);
    expect(setDeadlineCompleted).not.toHaveBeenCalled();
  });

  it("maps an unknown or foreign deadline to 400", async () => {
    const { controller, req } = buildController(
      jest.fn().mockResolvedValue(false),
    );

    await expect(
      controller.setCompleted(req, "foreign", { completed: false }),
    ).rejects.toThrow(BadRequestException);
  });
});
