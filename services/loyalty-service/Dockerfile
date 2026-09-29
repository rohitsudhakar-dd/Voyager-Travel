# syntax=docker/dockerfile:1

# ---- build ----
FROM node:20.17-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:20.17-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The node image already ships a non-root `node` user (uid 1000).
USER node
EXPOSE 4050

# Source Code Integration. Baked at build time because the running container
# has no git: without these two, an Error Tracking stack frame is text rather
# than a link to the line on the default branch.
ARG DD_GIT_REPOSITORY_URL=""
ARG DD_GIT_COMMIT_SHA=""
ENV DD_GIT_REPOSITORY_URL=$DD_GIT_REPOSITORY_URL \
    DD_GIT_COMMIT_SHA=$DD_GIT_COMMIT_SHA

# --require, not an import in the entrypoint: dd-trace patches modules as
# they are loaded, so it has to win the race against fastify and pg.
CMD ["node", "--require", "./dist/tracer.js", "dist/index.js"]
