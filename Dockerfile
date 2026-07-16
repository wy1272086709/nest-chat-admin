# syntax=docker/dockerfile:1.7

FROM node:20-bookworm AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app


FROM base AS dependencies

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile


FROM dependencies AS build

COPY nest-cli.json tsconfig.json ./
COPY config ./config
COPY prisma ./prisma
COPY src ./src

RUN pnpm prisma:generate
RUN pnpm build


FROM base AS production

ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps

COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile \
    && pnpm prisma:generate

COPY --from=build --chown=node:node /app/dist ./dist

RUN mkdir -p /app/dist/uploads \
    && chown -R node:node /app/dist/uploads

USER node

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
