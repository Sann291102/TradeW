import { Global, Module } from '@nestjs/common';
import { SmsService } from './sms.service';

/** Global for the same reason MailModule is: outbound SMS is infrastructure,
 *  and a consumer should not have to import a module to reach it. */
@Global()
@Module({
  providers: [SmsService],
  exports: [SmsService],
})
export class SmsModule {}
