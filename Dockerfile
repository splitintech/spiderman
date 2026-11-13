FROM node:24.13.1-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig*.json ./
COPY packages ./packages
RUN npm ci
RUN npm run build && npm prune --omit=dev

FROM node:24.13.1-bookworm-slim
ENV NODE_ENV=production
ENV SPIDERMAN_DB=/data/spiderman.db
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN apt-get update && apt-get install -y --no-install-recommends libdbus-1-3 libsecret-1-0 && rm -rf /var/lib/apt/lists/* && mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["serve", "--host", "0.0.0.0"]
