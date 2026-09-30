# syntax=docker/dockerfile:1

# ---- build ----
FROM golang:1.23-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal
# No -s -w. Those strip the symbol table and DWARF, and the Go profiler
# reads them to put function names on a flame graph; without them the
# profile is a wall of addresses (02-TECH-STACK.md § 4.2). -trimpath stays:
# it shortens paths to module-relative, which is what Source Code
# Integration wants anyway.
RUN go build -trimpath -o /out/search-service ./cmd/server

# ---- runtime ----
FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget \
 && adduser -D -u 10001 voyager
COPY --from=build /out/search-service /usr/local/bin/search-service

USER voyager
EXPOSE 4010

# Source Code Integration. Baked at build time because the running container
# has no git: without these two, an Error Tracking stack frame is text rather
# than a link to the line on the default branch.
ARG DD_GIT_REPOSITORY_URL=""
ARG DD_GIT_COMMIT_SHA=""
ENV DD_GIT_REPOSITORY_URL=$DD_GIT_REPOSITORY_URL \
    DD_GIT_COMMIT_SHA=$DD_GIT_COMMIT_SHA

ENTRYPOINT ["/usr/local/bin/search-service"]
