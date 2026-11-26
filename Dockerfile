# Stage 1: Build application dependencies
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./

# Prisma config requires DATABASE_URL during generation.
# This placeholder is only used during image build.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npm ci

COPY prisma ./prisma
COPY prisma.config.ts ./

RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate

# Remove development dependencies after generating Prisma Client.
RUN npm prune --omit=dev


# Stage 2: Production runtime
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node src ./src

USER node

EXPOSE 3000

CMD ["npm", "start"]
