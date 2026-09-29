# syntax=docker/dockerfile:1

# ---- build ----
FROM golang:1.23-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal
RUN go build -trimpath -ldflags="-s -w" -o /out/pricing-service ./cmd/server

# ---- runtime ----
FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget \
 && adduser -D -u 10001 voyager
COPY --from=build /out/pricing-service /usr/local/bin/pricing-service

USER voyager
EXPOSE 4020
ENTRYPOINT ["/usr/local/bin/pricing-service"]
