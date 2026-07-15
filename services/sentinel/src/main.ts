import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT || 4010);
  // internal service: bind to localhost by default; container/K8s deployments
  // override with HOST=0.0.0.0 behind the private network boundary
  await app.listen(port, process.env.HOST || '127.0.0.1');
  console.log(`Sentinel (internal) listening on ${process.env.HOST || '127.0.0.1'}:${port}`);
}
bootstrap();
