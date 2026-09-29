# syntax=docker/dockerfile:1

# Playwright's own image, because the browser build and the client library
# must be the same version -- a mismatch fails at launch with a message that
# points at neither. It also already carries Chromium's system libraries,
# which are about 400 MB of apt packages nobody should be assembling by hand.

# ---- build ----
FROM mcr.microsoft.com/playwright:v1.47.0-jammy AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM mcr.microsoft.com/playwright:v1.47.0-jammy
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

USER pwuser
CMD ["node", "dist/index.js"]
