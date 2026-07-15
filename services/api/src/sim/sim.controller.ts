import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsEnum, IsInt, IsString, Min } from 'class-validator';
import { OrderSide } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { SimService } from './sim.service';

class PlaceOrderDto {
  @IsString()
  instrumentId!: string;

  @IsEnum(OrderSide)
  side!: OrderSide;

  @IsInt()
  @Min(1)
  quantity!: number;
}

@UseGuards(AuthGuard)
@Controller('sim')
export class SimController {
  constructor(private readonly sim: SimService) {}

  @Post('orders')
  place(@Req() req: any, @Body() dto: PlaceOrderDto) {
    return this.sim.placeOrder(req.user.sub, dto.instrumentId, dto.side, dto.quantity);
  }

  @Get('positions')
  positions(@Req() req: any) { return this.sim.positions(req.user.sub); }
}
