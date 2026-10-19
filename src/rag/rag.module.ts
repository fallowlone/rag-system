import { Module } from "@nestjs/common";
import { IngestionModule } from "../ingestion/ingestion.module";
import { MemoryModule } from "../memory/memory.module";
import { RetrievalService } from "./retrieval.service";
import { AnswerService } from "./answer.service";
import { CitationVerifierService } from "./citation-verifier";
import { PalaceNavigationService } from "./palace-navigation.service";
import { InjectionClassifierService } from "./injection-classifier.service";
import { QueryPreprocessorService } from "./query-preprocessor.service";
import { ChatPipelineService } from "./chat-pipeline.service";
import { DocvaultService } from "./docvault.service";
import { RERANKING_PROVIDER } from "./rag.types";
import { LocalRerankingProvider } from "./local-reranking.provider";

@Module({
  imports: [IngestionModule, MemoryModule],
  providers: [
    {
      provide: RERANKING_PROVIDER,
      useClass: LocalRerankingProvider,
    },
    RetrievalService,
    AnswerService,
    CitationVerifierService,
    PalaceNavigationService,
    InjectionClassifierService,
    QueryPreprocessorService,
    ChatPipelineService,
    DocvaultService,
  ],
  exports: [
    AnswerService,
    RetrievalService,
    CitationVerifierService,
    PalaceNavigationService,
    InjectionClassifierService,
    QueryPreprocessorService,
    ChatPipelineService,
    DocvaultService,
  ],
})
export class RagModule {}
