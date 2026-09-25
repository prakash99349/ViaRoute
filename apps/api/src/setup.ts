import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { prisma } from '@viaroute/db';
import { config } from './config';

const customDomainCache = new Map<string, { ok: boolean; until: number }>();

/** Is this browser origin allowed to call the API? Main site, tenant subdomains, verified custom domains. */
async function allowedOrigin(origin: string): Promise<boolean> {
  const web = new URL(config.webOrigin);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === web.protocol && (url.hostname === web.hostname || url.hostname.endsWith(`.${web.hostname}`))) return true;
  if (url.protocol !== 'https:') return false;

  const cached = customDomainCache.get(url.hostname);
  if (cached && cached.until > Date.now()) return cached.ok;
  const ok = !!(await prisma.tenant.findFirst({ where: { customDomain: url.hostname, customDomainVerifiedAt: { not: null } }, select: { id: true } }));
  customDomainCache.set(url.hostname, { ok, until: Date.now() + 60_000 });
  return ok;
}

/** Shared by the server and the tests so both run the exact same stack. */
export function configureApp(app: NestExpressApplication) {
  app.use(helmet());
  app.useBodyParser('json', { limit: '1mb' }); // logo uploads
  app.enableCors({
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return cb(null, true);
      allowedOrigin(origin).then((ok) => cb(null, ok), () => cb(null, false));
    },
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Host'],
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  return app;
}
