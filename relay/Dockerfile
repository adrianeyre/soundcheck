# The Relay (ADR 0007) as a container. Built from the repository's root,
# as the Relay is part of its Cargo workspace:
#
#   docker build -f relay/Dockerfile -t soundcheck-relay .
#   docker run -p 8080:8080 soundcheck-relay
#
# It listens on PORT, 8080 unless it is set. Put it behind TLS (a host's
# proxy, or Caddy or nginx), so Soundcheck reaches it as wss://.

FROM rust:1-slim-trixie AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p soundcheck-relay

FROM debian:trixie-slim
COPY --from=build /src/target/release/soundcheck-relay /usr/local/bin/soundcheck-relay
USER nobody
ENV PORT=8080
EXPOSE 8080
CMD ["soundcheck-relay"]
