/**
 * Bucket storage (R2 / S3). Runs only against a real bucket:
 *   S3_TEST_BUCKET=… S3_TEST_ENDPOINT=http://localhost:9000 S3_TEST_KEY=… S3_TEST_SECRET=… pnpm test storage-s3
 */
import { StorageService } from '../src/common/storage.service';

const run = process.env.S3_TEST_BUCKET ? describe : describe.skip;

run('StorageService with a bucket', () => {
  let storage: StorageService;
  const key = `recordings/test-tenant/${Date.now()}.mp3`;

  beforeAll(() => {
    process.env.S3_BUCKET = process.env.S3_TEST_BUCKET;
    process.env.S3_ENDPOINT = process.env.S3_TEST_ENDPOINT;
    process.env.S3_ACCESS_KEY_ID = process.env.S3_TEST_KEY;
    process.env.S3_SECRET_ACCESS_KEY = process.env.S3_TEST_SECRET;
    storage = new StorageService();
  });

  afterAll(() => {
    for (const k of ['S3_BUCKET', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) delete process.env[k];
  });

  it('stores, sizes, links and deletes a recording', async () => {
    expect(storage.driver).toBe('s3');
    const audio = Buffer.from('ID3 fake mp3 audio');
    expect(await storage.put(key, audio)).toBe(key);
    expect(await storage.exists(key)).toBe(true);
    expect(await storage.size(key)).toBe(audio.length);

    const res = await fetch(await storage.bucketUrl(key, 'call 1.mp3'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="call_1.mp3"');
    expect(Buffer.from(await res.arrayBuffer()).equals(audio)).toBe(true);

    await storage.remove(key);
    expect(await storage.exists(key)).toBe(false);
  });

  it('refuses keys that escape the folder', async () => {
    await expect(storage.put('../etc/passwd', Buffer.from('x'))).rejects.toThrow('Invalid storage key');
  });
});
