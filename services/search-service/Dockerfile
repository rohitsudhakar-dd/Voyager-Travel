# syntax=docker/dockerfile:1

# ---- build ----
FROM golang:1.23-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal
RUN go build -trimpath -ldflags="-s -w" -o /out/search-service ./cmd/server

# ---- runtime ----
FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget \
 && adduser -D -u 10001 voyager
COPY --from=build /out/search-service /usr/local/bin/search-service

USER voyager
EXPOSE 4010
ENTRYPOINT ["/usr/local/bin/search-service"]
