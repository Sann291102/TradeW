import { Module } from '@nestjs/common';
import { CryptoController } from './crypto.controller';
import { CryptoService } from './crypto.service';
import { ForexController } from './forex.controller';
import { ForexService } from './forex.service';
import { StocksController } from './stocks.controller';
import { StocksService } from './stocks.service';

/**
 * External market data — everything NOT served by the Dhan pipeline.
 *
 *   /crypto     Binance          real, keyless, unlimited
 *   /forex      Twelve Data      real interbank spot
 *   /us-stocks  Twelve Data      US-listed equities
 *
 * Indian markets are deliberately absent: NIFTY, NSE equities, options and MCX
 * commodities are served by Dhan through /market-data and the feed bridge, in
 * more depth and with no per-minute quota. Twelve Data does not offer them on
 * this plan in any case.
 *
 * All three surfaces are READ-ONLY and none is placeable in the OMS — the money
 * path stores quantity as an Int and prices as Decimal(12,2), and is
 * rupee-denominated throughout. See each service for the specific reason.
 *
 * No PrismaModule: nothing here persists, and none of these instruments exists
 * in the Instrument table because nothing needs an FK to them.
 *
 * NOTE: the folder is still named `crypto/` from when that was its only
 * concern. The module's scope is wider than the folder name suggests.
 */
@Module({
  controllers: [CryptoController, ForexController, StocksController],
  providers: [CryptoService, ForexService, StocksService],
  exports: [CryptoService, ForexService, StocksService],
})
export class CryptoModule {}
