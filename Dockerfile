FROM node:22-bookworm-slim AS build

WORKDIR /app

ENV ONNXRUNTIME_NODE_INSTALL=skip

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN npm run build

# Deploy gate (build already ran the type check): a failing unit test stops the image build, so
# the rollout never starts and the running release keeps serving.
# (Integration tests need PostgreSQL/Redis and skip themselves here.)
RUN npm test

RUN npm prune --omit=dev \
    && npm cache clean --force \
    && node -e "require('onnxruntime-node')"


FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8090

COPY package.json package-lock.json ./

COPY --from=build \
    --chown=node:node \
    /app/node_modules \
    ./node_modules

COPY --from=build \
    --chown=node:node \
    /app/dist \
    ./dist

COPY --from=build \
    --chown=node:node \
    /app/drizzle \
    ./drizzle

USER node

EXPOSE 8090

CMD ["node", "dist/server/index.js"]
