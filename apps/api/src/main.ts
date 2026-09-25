import 'reflect-metadata';
import { config } from './config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './setup';

async function bootstrap() {
  // rawBody: needed to check Telnyx and Stripe webhook signatures.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  configureApp(app);
  app.enableShutdownHooks();

  await app.listen(config.port);
  Logger.log(`🚀 API ready on http://localhost:${config.port}`, 'Bootstrap');
}
bootstrap();
