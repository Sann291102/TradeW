import { Module } from '@nestjs/common';
import { NewsController } from './news.controller';
import { NewsService } from './news.service';

/**
 * Market news. No PrismaModule — headlines are read from public RSS on a
 * short server-side cache and nothing is persisted. The schema's NewsEvent
 * model is for the classified-event pipeline, which is a separate concern and
 * not wired here.
 */
@Module({
  controllers: [NewsController],
  providers: [NewsService],
  exports: [NewsService],
})
export class NewsModule {}
