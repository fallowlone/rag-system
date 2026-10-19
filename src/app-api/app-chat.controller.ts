import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { AppAuthGuard } from "./app-auth.guard";
import { AppChatService } from "./app-chat.service";
import { AppAuthedRequest } from "./app-api.types";

const ChatBodySchema = z.object({
  question: z.string().min(1).max(4000),
  language: z.enum(["ru", "de", "en", "uk"]).optional(),
});

@Controller("app/v1/chat")
@UseGuards(AppAuthGuard)
export class AppChatController {
  constructor(private readonly chatService: AppChatService) {}

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post()
  @HttpCode(200)
  async chat(
    @Req() req: AppAuthedRequest,
    @Body() rawBody: unknown,
  ): Promise<{ answer: string }> {
    const parsed = ChatBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const answer = await this.chatService.chat(
      req.appSession.userId,
      parsed.data.question,
      parsed.data.language,
    );
    return { answer };
  }
}
