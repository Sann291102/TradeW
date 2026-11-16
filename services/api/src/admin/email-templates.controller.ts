import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsObject, IsOptional } from 'class-validator';
import { OTP_LIMIT } from '../common/throttling';
import { SECURITY } from '../swagger/swagger.setup';
import { EmailService } from '../mail/email.service';
import { EMAIL_TEMPLATES, listTemplates, renderTemplate, TemplateRenderError, type EmailTemplateKey } from '../mail/email-templates';
import { PrismaService } from '../prisma/prisma.service';
import { AdminAccessGuard } from './admin-access.guard';

class PreviewDto {
  @ApiProperty({ required: false, type: Object, description: 'Override sample values (string values only).' })
  @IsOptional()
  @IsObject()
  vars?: Record<string, string>;
}

function templateOr404(key: string): EmailTemplateKey {
  if (!(key in EMAIL_TEMPLATES)) throw new NotFoundException('Unknown template.');
  return key as EmailTemplateKey;
}

/** Only string values, capped, so a preview request cannot smuggle markup-sized payloads. */
function cleanVars(vars: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars ?? {})) {
    if (/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(k) && typeof v === 'string') out[k] = v.slice(0, 500);
  }
  return out;
}

/**
 * Admin: email template catalogue, preview and test-send.
 *
 * Test-send goes ONLY to the signed-in operator's own address (from the
 * verified admin identity on the request, never from the request body), uses
 * fictional sample data, and is logged with `isTest=true`. There is no route
 * that sends a template to a customer from here.
 */
@ApiTags('Admin')
@ApiBearerAuth(SECURITY.bearer)
@UseGuards(AdminAccessGuard)
@Controller('admin/email-templates')
export class AdminEmailTemplatesController {
  constructor(
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list() {
    const since = new Date(Date.now() - 7 * 86400_000);
    const stats = await this.prisma.emailDeliveryLog.groupBy({
      by: ['templateKey', 'status'],
      where: { createdAt: { gt: since } },
      _count: { _all: true },
    });
    return {
      templates: listTemplates().map((t) => ({
        ...t,
        last7Days: Object.fromEntries(stats.filter((s) => s.templateKey === t.key).map((s) => [s.status, s._count._all])),
      })),
    };
  }

  @Post(':key/preview')
  preview(@Param('key') key: string, @Body() dto: PreviewDto) {
    const k = templateOr404(key);
    try {
      const rendered = renderTemplate(k, { ...EMAIL_TEMPLATES[k].sample, ...cleanVars(dto?.vars) });
      return { key: k, version: rendered.version, subject: rendered.subject, html: rendered.html, text: rendered.text };
    } catch (err) {
      if (err instanceof TemplateRenderError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Throttle(OTP_LIMIT)
  @Post(':key/test-send')
  async testSend(@Param('key') key: string, @Req() req: { user?: { email?: string } }) {
    const k = templateOr404(key);
    const to = req.user?.email;
    if (!to) throw new BadRequestException('Your admin identity has no email address to send a test to.');
    const result = await this.email.sendTemplate(k, to, { ...EMAIL_TEMPLATES[k].sample }, { isTest: true });
    return {
      to,
      status: result.delivered ? 'sent' : result.preview !== undefined ? 'logged (no mail provider configured)' : 'failed',
      attempts: result.attempts,
      error: result.error ?? null,
    };
  }

  @Get('deliveries/recent')
  async recent() {
    const rows = await this.prisma.emailDeliveryLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, templateKey: true, templateVersion: true, status: true, provider: true, attempts: true, lastError: true, isTest: true, createdAt: true, toAddress: true },
    });
    // Mask recipients: an operator reading delivery health does not need full addresses.
    return {
      deliveries: rows.map((r) => ({ ...r, toAddress: r.toAddress.replace(/^(.).*(@.*)$/, '$1***$2') })),
    };
  }
}
