import { Injectable, Logger } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHmac, timingSafeEqual } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { mkdir, rm, stat, writeFile } from 'fs/promises';
import { dirname, join, normalize, resolve } from 'path';
import type { Readable } from 'stream';
import { config } from '../config';

/**
 * Private file storage for call recordings.
 * - S3_BUCKET set: any S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze B2, DigitalOcean Spaces).
 * - Otherwise: local disk (STORAGE_DIR, default ./storage).
 * Either way the app hands out its own signed /files/… links; with a bucket those redirect to a
 * short-lived bucket link, so audio never streams through the API.
 */
@Injectable()
export class StorageService {
  private readonly log = new Logger(StorageService.name);
  private readonly root = resolve(process.env.STORAGE_DIR ?? join(__dirname, '../../../../storage'));
  private readonly bucket = process.env.S3_BUCKET || '';
  private readonly s3 = this.bucket
    ? new S3Client({
        region: process.env.S3_REGION || 'auto',
        endpoint: process.env.S3_ENDPOINT || undefined, // R2: https://<account id>.r2.cloudflarestorage.com
        forcePathStyle: !!process.env.S3_ENDPOINT,
        credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '' },
      })
    : null;

  /** "s3" when files live in a bucket, "local" on this server's disk. */
  get driver() {
    return this.s3 ? 's3' : 'local';
  }

  async put(key: string, data: Buffer): Promise<string> {
    if (this.s3) {
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.check(key), Body: data, ContentType: contentType(key) }));
      return key;
    }
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return key;
  }

  async size(key: string): Promise<number | null> {
    try {
      if (this.s3) return (await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.check(key) }))).ContentLength ?? null;
      return (await stat(this.pathFor(key))).size;
    } catch {
      return null;
    }
  }

  async remove(key: string) {
    if (this.s3) {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.check(key) }));
      return;
    }
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    if (this.s3) return (await this.size(key)) !== null;
    return existsSync(this.pathFor(key));
  }

  /** Local disk only: the file's contents. */
  read(key: string): Readable {
    return createReadStream(this.pathFor(key));
  }

  /** Bucket only: a direct link valid for a few minutes. */
  async bucketUrl(key: string, download?: string): Promise<string> {
    if (!this.s3) throw new Error('No bucket configured');
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.check(key),
        ResponseContentType: contentType(key),
        ...(download ? { ResponseContentDisposition: `attachment; filename="${safeName(download)}"` } : {}),
      }),
      { expiresIn: 600 },
    );
  }

  /** Downloads a file from a (temporary) URL and stores it. */
  async putFromUrl(key: string, url: string, headers?: Record<string, string>): Promise<string | null> {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await this.put(key, Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      this.log.error(`Could not store ${key}: ${(e as Error).message}`);
      return null;
    }
  }

  /** A link that works without a login for a short time (for <audio> players). With `download`, it saves as that file name. */
  signedPath(key: string, ttlSec = 15 * 60, download?: string) {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return `/files/${encodeURI(key)}?exp=${exp}&sig=${sign(key, exp)}${download ? `&dl=${encodeURIComponent(download)}` : ''}`;
  }

  verify(key: string, exp: number, sig: string) {
    if (!exp || exp < Date.now() / 1000) return false;
    const expected = Buffer.from(sign(key, exp));
    const given = Buffer.from(sig ?? '');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private check(key: string) {
    if (key.startsWith('/') || key.split('/').includes('..')) throw new Error('Invalid storage key');
    return key;
  }

  private pathFor(key: string) {
    const path = normalize(join(this.root, key));
    if (!path.startsWith(this.root)) throw new Error('Invalid storage key');
    return path;
  }
}

export const contentType = (key: string) => (key.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');
export const safeName = (name: string) => name.replace(/[^A-Za-z0-9._+-]/g, '_').slice(0, 100);

function sign(key: string, exp: number) {
  return createHmac('sha256', config.jwtSecret).update(`${key}:${exp}`).digest('base64url');
}
