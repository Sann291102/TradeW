import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { MarketDataService } from './market-data.service';

@UseGuards(AuthGuard)
@Controller('market-data')
export class MarketDataController {
  constructor(private readonly marketData: MarketDataService) {}

  @Get('quote/:instrumentId')
  quote(@Param('instrumentId') instrumentId: string) { return this.marketData.quote(instrumentId); }
}
