import { Body, Controller, Get, Patch, Param, Post, Req, UseGuards, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { NotificationService, NotificationCategoryType } from './notification.service';

type AuthedRequest = { user: { sub: string } };

class CreateNotificationDto {
  @ApiProperty({ description: 'Notification category.' })
  category!: NotificationCategoryType;

  @ApiProperty()
  title!: string;

  @ApiProperty({ description: 'Body text.' })
  body!: string;
}

@ApiTags('Notifications')
@ApiBearerAuth(SECURITY.bearer)
@UseGuards(AuthGuard)
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  /** The caller's notifications, newest first. */
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @Get()
  async list(@Req() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.notifications.list(req.user.sub, limit ? Number(limit) : 50);
  }

  /** Unread badge count for the caller. */
  @Get('unread-count')
  async unreadCount(@Req() req: AuthedRequest) {
    return { count: await this.notifications.unreadCount(req.user.sub) };
  }

  /** Raise a notification against the caller's own feed. */
  @Post()
  async create(@Req() req: AuthedRequest, @Body() dto: CreateNotificationDto) {
    return this.notifications.create(req.user.sub, dto);
  }

  /** Mark one notification read. Scoped to the caller — a foreign id is a no-op. */
  @Patch(':id/read')
  async markRead(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.notifications.markRead(req.user.sub, id);
    return { ok: true };
  }

  /** Mark every notification read. */
  @Patch('read-all')
  async markAllRead(@Req() req: AuthedRequest) {
    await this.notifications.markAllRead(req.user.sub);
    return { ok: true };
  }
}