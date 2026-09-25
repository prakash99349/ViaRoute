import 'reflect-metadata';
import { config } from './config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ensurePlans, ensureSuperAdmin } from './cli/bootstrap-admin';
import { configureApp } from './setup';

async function bootstrap() {
  // rawBody: needed to check Telnyx and Stripe webhook signatures.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  configureApp(app);
  app.enableShutdownHooks();

  // Platforms without a terminal (xCloud, Coolify…): create the first admin from the environment.
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    if (ADMIN_PASSWORD.length < 12) Logger.warn('ADMIN_PASSWORD must be 12+ characters; admin not created', 'Bootstrap');
    else {
      await ensurePlans();
      const result = await ensureSuperAdmin(ADMIN_EMAIL, ADMIN_PASSWORD, false);
      if (result === 'created') Logger.log(`Super Admin ${ADMIN_EMAIL} created`, 'Bootstrap');
    }
  }

  await app.listen(config.port);
  Logger.log(`🚀 API ready on http://localhost:${config.port}`, 'Bootstrap');
}
bootstrap();
