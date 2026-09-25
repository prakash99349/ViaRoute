import type { INestApplication } from '@nestjs/common';
import { prisma } from '@viaroute/db';
import { createApp, portal, resetDb, signupTenant, tokenFromEmail, uid } from './helpers';

let app: INestApplication;

beforeAll(async () => {
  await resetDb();
  app = await createApp();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function inviteAndAccept(owner: { sub: string; token: string }, role: 'MANAGER' | 'TENANT_ADMIN' = 'MANAGER') {
  const email = `member${uid()}@${owner.sub}.test`;
  const inv = await portal(app, owner.sub, owner.token).post('/team/invite', { email, name: 'New Member', role }).expect(201);
  const token = await tokenFromEmail(email, '/accept-invite');
  const accepted = await portal(app, owner.sub).post('/auth/accept-invite', { token, password: 'Member1234' }).expect(200);
  return { id: inv.body.id as string, email, token: accepted.body.token as string };
}

describe('Team', () => {
  it('invites a member who accepts and can log in', async () => {
    const owner = await signupTenant(app);
    const m = await inviteAndAccept(owner);

    const me = await portal(app, owner.sub, m.token).get('/auth/me').expect(200);
    expect(me.body).toMatchObject({ email: m.email, role: 'MANAGER', emailVerified: true });

    const list = await portal(app, owner.sub, owner.token).get('/team').expect(200);
    expect(list.body.members).toHaveLength(2);
  });

  it('shows invited people as pending, and they cannot log in yet', async () => {
    const owner = await signupTenant(app);
    const email = `pending${uid()}@x.test`;
    await portal(app, owner.sub, owner.token).post('/team/invite', { email, name: 'Pending Person', role: 'MANAGER' }).expect(201);

    const list = await portal(app, owner.sub, owner.token).get('/team').expect(200);
    expect(list.body.members.find((u: { email: string }) => u.email === email).pending).toBe(true);
    await portal(app, owner.sub).post('/auth/login', { email, password: 'anything123' }).expect(401);
  });

  it('only admins can invite', async () => {
    const owner = await signupTenant(app);
    const manager = await inviteAndAccept(owner);
    await portal(app, owner.sub, manager.token)
      .post('/team/invite', { email: `x${uid()}@x.test`, name: 'Someone', role: 'MANAGER' })
      .expect(403);
  });

  it('rejects duplicate emails', async () => {
    const owner = await signupTenant(app);
    await portal(app, owner.sub, owner.token)
      .post('/team/invite', { email: owner.email, name: 'Dup Licate', role: 'MANAGER' })
      .expect(409);
  });

  it('enforces the plan user limit (Starter = 3)', async () => {
    const owner = await signupTenant(app);
    const api = portal(app, owner.sub, owner.token);
    await api.post('/team/invite', { email: `a${uid()}@x.test`, name: 'Member A', role: 'MANAGER' }).expect(201);
    await api.post('/team/invite', { email: `b${uid()}@x.test`, name: 'Member B', role: 'MANAGER' }).expect(201);
    const res = await api.post('/team/invite', { email: `c${uid()}@x.test`, name: 'Member C', role: 'MANAGER' }).expect(403);
    expect(res.body.message).toContain('Starter plan allows 3 users');
  });

  it('changes roles immediately (no need to log in again)', async () => {
    const owner = await signupTenant(app);
    const m = await inviteAndAccept(owner);
    await portal(app, owner.sub, owner.token).patch(`/team/${m.id}/role`, { role: 'TENANT_ADMIN' }).expect(200);
    // The member's existing token now has admin rights.
    await portal(app, owner.sub, m.token)
      .post('/team/invite', { email: `x${uid()}@x.test`, name: 'Someone', role: 'MANAGER' })
      .expect(201);
  });

  it('protects the last admin and yourself', async () => {
    const owner = await signupTenant(app);
    const me = await portal(app, owner.sub, owner.token).get('/auth/me').expect(200);
    await portal(app, owner.sub, owner.token).delete(`/team/${me.body.id}`).expect(400);
    await portal(app, owner.sub, owner.token).patch(`/team/${me.body.id}/role`, { role: 'MANAGER' }).expect(400);
  });

  it('removes a member and ends their session', async () => {
    const owner = await signupTenant(app);
    const m = await inviteAndAccept(owner);
    await portal(app, owner.sub, owner.token).delete(`/team/${m.id}`).expect(200);
    await portal(app, owner.sub, m.token).get('/auth/me').expect(401);
  });
});

describe('🔒 Tenant isolation', () => {
  it("rejects one customer's token on another customer's portal", async () => {
    const a = await signupTenant(app);
    const b = await signupTenant(app);
    await portal(app, b.sub, a.token).get('/tenant').expect(401);
    await portal(app, b.sub, a.token).get('/team').expect(401);
  });

  it("never lists or touches another customer's team members", async () => {
    const a = await signupTenant(app);
    const b = await signupTenant(app);
    const bMember = await inviteAndAccept(b);

    const aTeam = await portal(app, a.sub, a.token).get('/team').expect(200);
    expect(aTeam.body.members.map((u: { email: string }) => u.email)).not.toContain(bMember.email);

    // Using B's member id from A's portal must look like it doesn't exist.
    await portal(app, a.sub, a.token).patch(`/team/${bMember.id}/role`, { role: 'TENANT_ADMIN' }).expect(404);
    await portal(app, a.sub, a.token).delete(`/team/${bMember.id}`).expect(404);
    await portal(app, b.sub, bMember.token).get('/auth/me').expect(200); // still there
  });

  it('blocks customers from the super admin API', async () => {
    const a = await signupTenant(app);
    await portal(app, a.sub, a.token).get('/admin/tenants').expect(403);
  });

  it("won't accept an invite link on another customer's portal", async () => {
    const a = await signupTenant(app);
    const b = await signupTenant(app);
    const email = `inv${uid()}@x.test`;
    await portal(app, a.sub, a.token).post('/team/invite', { email, name: 'Invited Person', role: 'MANAGER' }).expect(201);
    const token = await tokenFromEmail(email, '/accept-invite');
    await portal(app, b.sub).post('/auth/accept-invite', { token, password: 'Password123' }).expect(400);
  });
});
