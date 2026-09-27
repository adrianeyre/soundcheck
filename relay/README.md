# The Soundcheck Relay

The members of a **Live Session** (ADR 0007) each connect to a Relay, and it
passes every frame one of them sends to all the others in that session, as
it comes. That is all it does:

- **It can't read what it passes on.** Soundcheck encrypts every frame with
  AES-GCM under a key that lives only in the session's invite link, after
  the `#`, which browsers never send to a server. The Relay sees session ids,
  sizes and timing, never a song.
- **It stores nothing.** A member who joins late, or reconnects, catches up
  from the other members and from the Project folder, not from here.
- **No accounts.** A session is whatever its id says. The id and the key are
  random, and anyone with the invite link can join.

## Limits

The defaults in `src/lib.rs` (`Limits`):

| Limit | Default | Past it |
| --- | --- | --- |
| A frame | 1 MiB | The sender's connection ends. Soundcheck splits anything larger. |
| What one member sends | 2 MiB a second, 8 MiB at once | The Relay reads from them more slowly. Nothing is lost. |
| Members in a session | 16 | One more is refused (HTTP 403). |
| Members on the Relay | 2000 | One more is refused (HTTP 503). |
| Frames waiting for one member | 64 | That member is let go (close code 1013) and reconnects to catch up. |

A member is pinged every 20 seconds, so proxies keep a quiet connection open.

## Running it

```sh
cargo run --release -p soundcheck-relay            # on 0.0.0.0:8080
HOST=127.0.0.1 PORT=9000 cargo run --release -p soundcheck-relay
```

or as a container, built from the repository's root:

```sh
docker build -f relay/Dockerfile -t soundcheck-relay .
docker run -p 8080:8080 soundcheck-relay
```

CI builds that image for every change, and once a change is on `main` it
publishes it as `ghcr.io/<owner>/<repository>/relay`, tagged `latest` and with
the commit.

`GET /` answers `Soundcheck Relay`, for a health check. Sessions are at
`/session/<id>`.

Soundcheck needs to reach it as `wss://` from the Browser Version, which is
served over HTTPS, so put it behind TLS: a host's own proxy, or Caddy or nginx
in front of it. Any host that runs a container and passes WebSockets through
will do.

## Pointing Soundcheck at it

- **For everyone:** the repository variable `RELAY_URL` (Settings → Secrets
  and variables → Actions → Variables), such as `wss://relay.example.com`,
  is built into the Desktop App and the Browser Version as the Relay they
  start with. Without it they have none, and Live Sessions need an address
  in Settings.
- **For one person:** Settings → Collaboration → Relay address.

Where the public Relay runs, and who runs it, is ADR 0012's to decide.
