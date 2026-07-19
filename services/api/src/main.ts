import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Allowed browser origins. FRONTEND_URL may be a comma-separated list.
  const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const isProd = process.env.NODE_ENV === 'production';

  app.enableCors({
    // Production: strict allowlist. Development: also accept any localhost/
    // 127.0.0.1 port (the web dev server uses a dynamic port) and non-browser
    // tools (no Origin header), so the frontend can reach the API regardless of
    // which port the dev server landed on.
    origin: isProd
      ? allowedOrigins
      : (origin, cb) => {
          const ok =
            !origin ||
            allowedOrigins.includes(origin) ||
            /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
          cb(null, ok);
        },
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.PORT || 4000);
  await app.listen(port);
  console.log(`TradeW backend listening on ${port}`);
}
bootstrap();
