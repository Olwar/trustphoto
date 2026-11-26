import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { SiteConfig } from '@trustphoto/web';
import type { Context } from './context.js';
import { registerApi } from './routes/api.js';
import { registerWeb } from './routes/web.js';
import { clientIp } from './client-ip.js';

export async function buildApp(ctx: Context, opts: { site: SiteConfig; publicDir: string; logger?: boolean }): Promise<FastifyInstance> {
  const app = Fastify({
    // Request logs carry the method and the path only: no client address, no headers.
    logger: opts.logger
      ? { serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split('?')[0] }) } }
      : false,
    bodyLimit: 64 * 1024,
    // requestTimeout ends slow uploads (the whole request must arrive within it). The idle-socket
    // timeout is longer than the worst verification time, so a busy server still delivers its answer.
    connectionTimeout: 150_000,
    requestTimeout: 90_000,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    // The proof image may be embedded by other sites (that is the point of a public proof).
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', keyGenerator: (request) => clientIp(request, ctx.cfg) });
  await app.register(multipart);
  await app.register(fastifyStatic, { root: opts.publicDir, prefix: '/assets/', decorateReply: false, maxAge: '1h' });

  registerApi(app, ctx);
  registerWeb(app, ctx, opts.site);

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    if (status === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Wait a minute and try again.' } });
    return reply
      .code(status)
      .send({ error: { code: status >= 500 ? 'internal' : 'bad_request', message: status >= 500 ? 'Something went wrong. Try again.' : error.message } });
  });

  return app;
}
