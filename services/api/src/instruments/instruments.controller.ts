import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { InstrumentsService } from './instruments.service';

@ApiTags('Instruments')
@ApiBearerAuth(SECURITY.bearer)
@UseGuards(AuthGuard)
@Controller('instruments')
export class InstrumentsController {
  constructor(private readonly instruments: InstrumentsService) {}

  /** Free-text instrument lookup by symbol or name. */
  @Get('search')
  search(@Query('q') q?: string) { return this.instruments.search(q || ''); }
}
