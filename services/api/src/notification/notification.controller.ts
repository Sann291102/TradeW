import { Body, Controller, Get, Patch, Param, Post, Req, UseGuards, Query } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { NotificationService, NotificationCategoryType } from './notification.service';

type AuthedRequest = { user: { sub: string } };

class CreateNotificationDto {
  category!: NotificationCategoryType;
  title!: string;
  body!: string;
}

@UseGuards(AuthGuard)
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  async list(@Req() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.notifications.list(req.user.sub, limit ? Number(limit) : 50);
  }

  @Get('unread-count')
  async unreadCount(@Req() req: AuthedRequest) {
    return { count: await this.notifications.unreadCount(req.user.sub) };
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() dto: CreateNotificationDto) {
    return this.notifications.create(req.user.sub, dto);
  }

  @Patch(':id/read')
  async markRead(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.notifications.markRead(req.user.sub, id);
    return { ok: true };
  }

  @Patch('read-all')
  async markAllRead(@Req() req: AuthedRequest) {
    await this.notifications.markAllRead(req.user.sub);
    return { ok: true };
  }
}