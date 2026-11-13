FROM node:24.13.1-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig*.json ./
COPY packages ./packages
RUN npm ci
RUN npm run build && npm prune --omit=dev

FROM node:24.13.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8787
ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["serve", "--host", "0.0.0.0"]
