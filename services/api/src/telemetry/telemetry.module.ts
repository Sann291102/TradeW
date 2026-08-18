import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ApiCallInterceptor } from './api-call.interceptor';
import { TelemetryService } from './telemetry.service';

/**
 * Global so any module can inject `TelemetryService` (the admin module reads
 * its live bus; feature modules can record domain events) without listing it
 * as an import — the same treatment `PrismaModule` gets, and for the same
 * reason: it is infrastructure, not a feature dependency.
 *
 * `APP_INTERCEPTOR` registers `ApiCallInterceptor` across every route in the
 * application, including routes added later. That blanket registration is the
 * point — see the interceptor's own note on why partial coverage would be
 * worse than none.
 */
@Global()
@Module({
  providers: [TelemetryService, { provide: APP_INTERCEPTOR, useClass: ApiCallInterceptor }],
  exports: [TelemetryService],
})
export class TelemetryModule {}
