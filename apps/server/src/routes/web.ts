import type { FastifyInstance } from 'fastify';
import { renderHome, renderNotFound, renderPrivacy, renderProof, type SiteConfig } from '@trustphoto/web';
import type { Context } from '../context.js';
import { isPhotoId } from '../ids.js';
import { findPhoto, toPublicPhoto } from '../services/photos.js';
import { photoKeys } from '../storage.js';

const PAGE_CACHE = 'public, max-age=60';
/** Short enough that an owner delete clears from caches within the hour. */
const IMAGE_CACHE = 'public, max-age=3600';

export function registerWeb(app: FastifyInstance, ctx: Context, site: SiteConfig): void {
  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', PAGE_CACHE).send(renderHome(site)));

  app.get('/privacy', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').header('Cache-Control', PAGE_CACHE).send(renderPrivacy(site)),
  );

  app.get<{ Params: { id: string }; Querystring: { from?: string } }>('/p/:id', async (request, reply) => {
    const row = isPhotoId(request.params.id) ? await findPhoto(ctx.db, request.params.id) : null;
    if (!row) return reply.code(404).type('text/html; charset=utf-8').send(renderNotFound(site, `/p/${request.params.id}`, 'proof'));
    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', PAGE_CACHE)
      .send(renderProof(site, toPublicPhoto(row, ctx.cfg.publicBaseUrl), { fromSimilar: request.query.from === 'similar' }));
  });

  app.get<{ Params: { id: string } }>('/p/:id/receipt.json', async (request, reply) => {
    const row = isPhotoId(request.params.id) ? await findPhoto(ctx.db, request.params.id) : null;
    if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'This proof is not available.' } });
    return reply.header('Cache-Control', PAGE_CACHE).send({
      receipt: row.receipt,
      signature: row.signature,
      algorithm: 'Ed25519',
      signedBytes: 'canonical JSON of `receipt` (keys sorted, no spaces)',
      keys: `${ctx.cfg.publicBaseUrl}/.well-known/trustphoto-keys.json`,
    });
  });

  app.get<{ Params: { file: string } }>('/i/:file', async (request, reply) => imageResponse(request.params.file, 'display', reply));
  app.get<{ Params: { id: string } }>('/i/:id/preview.jpg', async (request, reply) => imageResponse(`${request.params.id}.jpg`, 'preview', reply));

  async function imageResponse(file: string, kind: 'display' | 'preview', reply: import('fastify').FastifyReply) {
    const id = /^([0-9A-Za-z]{12})\.jpg$/.exec(file)?.[1];
    const row = id ? await findPhoto(ctx.db, id) : null;
    const body = row ? await ctx.storage.get(photoKeys[kind](row.id)) : null;
    if (!body) return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
    return reply.type('image/jpeg').header('Cache-Control', IMAGE_CACHE).send(body);
  }

  app.get('/.well-known/trustphoto-keys.json', async (_request, reply) =>
    reply.header('Cache-Control', 'public, max-age=3600').send({ keys: ctx.signer.publishedJwks }),
  );

  app.get('/health', async () => ({ ok: true }));

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/v1/') || request.method !== 'GET') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
    }
    return reply.code(404).type('text/html; charset=utf-8').send(renderNotFound(site, request.url.split('?')[0]));
  });
}
