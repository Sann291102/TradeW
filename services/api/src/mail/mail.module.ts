import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { EmailService } from './email.service';

/**
 * Outbound mail. Global so any module can send without importing this one.
 * `MailService` is the transport; `EmailService` is the template-driven
 * sender (render, retry, delivery log) that new code should use.
 */
@Global()
@Module({
  providers: [MailService, EmailService],
  exports: [MailService, EmailService],
})
export class MailModule {}
