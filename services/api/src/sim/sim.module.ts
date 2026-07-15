import { Module } from '@nestjs/common';
import { SimController } from './sim.controller';
import { SimService } from './sim.service';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({ imports: [MarketDataModule], controllers: [SimController], providers: [SimService] })
export class SimModule {}
