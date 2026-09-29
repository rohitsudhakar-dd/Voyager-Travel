# syntax=docker/dockerfile:1

# The build context is the repository root, because the bundle pulls zod schemas
# from packages/shared-schemas. The root .dockerignore trims it: unignored, the
# daemon uploads 1.1 GB for an image whose inputs are about 4 MB. Only this
# image builds from the root, so nothing else inherits those exclusions.

# ---- build ----
FROM node:20.17-alpine AS build
WORKDIR /app

COPY apps/web-ui/package.json apps/web-ui/package-lock.json ./
RUN npm ci

# One level above the app, exactly as in the repo, so the '@voyager/shared-schemas'
# alias and zod's resolution both behave the same here as they do on a laptop.
COPY packages/shared-schemas/package.json packages/shared-schemas/package-lock.json /packages/shared-schemas/
RUN cd /packages/shared-schemas && npm ci
COPY packages/shared-schemas/src /packages/shared-schemas/src

COPY apps/web-ui/tsconfig.json apps/web-ui/vite.config.ts apps/web-ui/tailwind.config.ts ./
COPY apps/web-ui/postcss.config.js apps/web-ui/index.html ./
COPY apps/web-ui/scripts ./scripts
COPY apps/web-ui/public ./public
COPY apps/web-ui/src ./src

# Every VITE_* value is substituted into the bundle by Vite at build time, so
# all of them are build args. Passing one as runtime environment instead does
# nothing at all: the container serves the value that was compiled in, which
# reads as a caching bug rather than a configuration mistake.
ARG DD_ENV=demo
ARG DD_VERSION=dev
ARG DD_GIT_COMMIT_SHA=unknown
ARG DD_GIT_REPOSITORY_URL=""
ARG VITE_USE_MOCKS=false
# Relative by default so the bundle works behind any hostname. An absolute URL
# is only correct when the browser reaches the API somewhere other than the
# origin that served the page.
ARG VITE_API_BASE_URL=/api
ARG VITE_DD_SITE=datadoghq.com
ENV VITE_USE_MOCKS=${VITE_USE_MOCKS} \
    VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_DD_SITE=${VITE_DD_SITE} \
    VITE_DD_ENV=${DD_ENV} \
    VITE_DD_VERSION=${DD_VERSION} \
    VITE_DD_GIT_COMMIT_SHA=${DD_GIT_COMMIT_SHA}

RUN npm run build

# ---- runtime ----
FROM nginx:1.27-alpine
ENV NODE_ENV=production

COPY apps/web-ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web-ui/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html

# Sourcemaps are built for Datadog and uploaded at deploy time, never served
# (02-TECH-STACK.md § 3).
RUN find /usr/share/nginx/html -name '*.map' -delete

# nginx:alpine ships an unprivileged `nginx` user (uid 101) but runs as root by
# default. The pid moves to /tmp because /var/run is a symlink into root-owned
# /run, and the `user` directive is dropped because it is meaningless once the
# master process is not root and nginx warns about it on every boot.
RUN mkdir -p /var/cache/nginx \
 && chown -R nginx:nginx /var/cache/nginx /usr/share/nginx/html /etc/nginx/conf.d \
 && sed -i 's|^pid .*|pid /tmp/nginx.pid;|; s|^user .*||' /etc/nginx/nginx.conf

USER nginx
EXPOSE 8080

# 127.0.0.1, not localhost: busybox wget resolves localhost to ::1 first and
# this nginx listens on IPv4 only, so the name form reports the container
# unhealthy while it is serving every request perfectly well.
HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
