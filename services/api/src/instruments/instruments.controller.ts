import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { InstrumentsService } from './instruments.service';

@UseGuards(AuthGuard)
@Controller('instruments')
export class InstrumentsController {
  constructor(private readonly instruments: InstrumentsService) {}

  @Get('search')
  search(@Query('q') q?: string) { return this.instruments.search(q || ''); }
}
