# The server and the website. The phone app (apps/mobile) is not part of the image:
# only its package.json is copied, so the workspace layout matches the lockfile.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --workspace apps/server --workspace apps/web --workspace packages/shared --include-workspace-root
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/server apps/server
RUN npm run build
RUN npm prune --omit=dev --workspace apps/server --workspace apps/web --workspace packages/shared --include-workspace-root

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/apps/web/package.json apps/web/package.json
COPY --from=build /app/apps/web/public apps/web/public
COPY --from=build /app/apps/server/package.json apps/server/package.json
# npm puts a package here when the server needs another version than the root has (zod 4, sharp 0.35).
COPY --from=build /app/apps/server/node_modules apps/server/node_modules
COPY --from=build /app/apps/server/dist apps/server/dist
# The embedded database and photo folder of a development start (production uses DATABASE_URL and a bucket).
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
