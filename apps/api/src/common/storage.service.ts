import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join, normalize, resolve } from 'path';
import type { Readable } from 'stream';
import { config } from '../config';

/**
 * Private file storage for call recordings.
 * Local disk for now (./storage); swap for S3/R2 at deploy time (see PLAN Stage 2).
 */
@Injectable()
export class StorageService {
  private readonly log = new Logger(StorageService.name);
  private readonly root = resolve(process.env.STORAGE_DIR ?? join(__dirname, '../../../../storage'));

  async put(key: string, data: Buffer): Promise<string> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return key;
  }

  exists(key: string) {
    return existsSync(this.pathFor(key));
  }

  read(key: string): Readable {
    return createReadStream(this.pathFor(key));
  }

  /** Downloads a file from a (temporary) URL and stores it. */
  async putFromUrl(key: string, url: string, headers?: Record<string, string>): Promise<string | null> {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await this.put(key, Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      this.log.error(`Could not download ${key}: ${(e as Error).message}`);
      return null;
    }
  }

  /** A link that works without a login for a short time (for <audio> players). */
  signedPath(key: string, ttlSec = 15 * 60) {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return `/files/${encodeURI(key)}?exp=${exp}&sig=${sign(key, exp)}`;
  }

  verify(key: string, exp: number, sig: string) {
    if (!exp || exp < Date.now() / 1000) return false;
    const expected = Buffer.from(sign(key, exp));
    const given = Buffer.from(sig ?? '');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private pathFor(key: string) {
    const path = normalize(join(this.root, key));
    if (!path.startsWith(this.root)) throw new Error('Invalid storage key');
    return path;
  }
}

function sign(key: string, exp: number) {
  return createHmac('sha256', config.jwtSecret).update(`${key}:${exp}`).digest('base64url');
}
