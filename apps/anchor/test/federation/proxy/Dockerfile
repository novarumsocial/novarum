# Stripe's smokescreen: an SSRF-filtering CONNECT proxy that denies private, loopback and link-local destinations.
FROM golang:1.25-alpine AS build
RUN go install github.com/stripe/smokescreen@latest

FROM alpine:3.22
COPY --from=build /go/bin/smokescreen /usr/local/bin/smokescreen
ENTRYPOINT ["smokescreen"]
