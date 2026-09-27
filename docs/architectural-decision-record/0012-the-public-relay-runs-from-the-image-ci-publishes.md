# The public Relay runs from the container image CI publishes, wherever the maintainer puts it

**Status: proposed** in the v4 pull request (#76). ADR 0007 left open who runs the public **Relay** and where. What the maintainer has to decide, and do, is under [To confirm](#to-confirm).

A **Live Session** needs a Relay: each member's Changes go to it, and it passes them on to the others ([ADR 0007](0007-collaboration-by-an-ordered-log-of-changes.md)). #76 built the Relay as `relay/` in this repository ([its README](../../relay/README.md)): a small Rust program that fans WebSocket frames out to the members of a session. Everything it passes is sealed with a key it never sees, and it stores nothing. Running one for everyone costs money every month and needs an account with some host, so that part is the maintainer's to decide.

## Decision

### What is built and wired

- **The image.** CI builds `relay/Dockerfile` for every change and checks that the container starts and answers `GET /`. Once a change is on `main`, CI pushes the image to the GitHub Container Registry as `ghcr.io/<owner>/<repository>/relay`, tagged `latest` and with the commit. That needs only the workflow's own token: no secret.
- **The default address.** The repository variable `RELAY_URL` (a variable, not a secret: the address is public) is built into the Desktop App and the Browser Version as `VITE_RELAY_URL`. It is the Relay they start with.
- **Without it,** Soundcheck has no default Relay. *Start a Live Session* then says a Relay is needed and points to Settings → Collaboration → Relay address. Everything else works as before, and sharing a Project through a folder needs no Relay at all.
- **Anyone can run their own** with `docker run` or `cargo run -p soundcheck-relay`, and point their copy at it in Settings. An invite link carries the Relay's address, so whoever joins uses the same one.

### What to run it on

Nothing in the Relay ties it to a host. It is one process with no disk and no database. It needs:

- a container runtime, or any Linux machine to run the binary on;
- WebSockets passed through;
- TLS in front, so the Browser Version, served over HTTPS, can reach it as `wss://`.

The options, each of which runs the published image as it is:

- **A small VM** (any cloud's cheapest, or a Raspberry Pi at home) with Caddy in front for TLS. The cheapest for sustained bandwidth, and the most to look after.
- **A container platform** such as Fly.io, Railway, Render, Google Cloud Run or Azure Container Apps. The platform does TLS and restarts, and bills by the hour and by the gigabyte. Check that it keeps WebSockets open for as long as a session lasts: the Relay pings every 20 seconds, which keeps most proxies from closing a quiet one.
- **None.** Soundcheck ships with no default. Musicians who want Live Sessions run a Relay themselves, and folder sync covers everyone else.

This ADR recommends **a container platform, run by the maintainer**, with `RELAY_URL` set to it. It is the least to look after, and the Relay stores nothing that could be lost if the platform restarts it. Its cost is bandwidth, mostly audio passed through in Live Sessions (up to 64 MiB a file, at most 2 MiB a second per member, by the Relay's limits) and a little CPU.

## Why

- **The image, not a deploy workflow.** A deploy needs a host's credentials, which only exist once the maintainer has chosen one. Publishing the image is the part that needs no choice: any of the hosts above can pull it. Once one is chosen, deploying is that host's own step, or a short CI job with its token as a secret, skipped while the secret is missing like the signing jobs.
- **A variable, not a secret.** The Relay's address is in every invite link, so there is nothing to hide. A variable also shows in the build logs, which helps when something is wrong.
- **No default until there is one.** Pointing the app at an address nobody runs would make *Start a Live Session* fail for everyone. Saying that a Relay is needed, and where to set it, is clearer.

## Consequences

- Every change on `main` publishes a new `latest` image. A host that pulls `latest` on restart follows `main`. To pin a version, use the commit tag.
- The Relay's limits are in `relay/src/lib.rs` (`Limits::default`) and its README. Changing them for a host means a code change and a new image, which keeps them reviewed.
- The Relay's operator can see who connects (IP addresses) and when, and how much they send, but never what. The README says so. Nobody can be kept out of a session except by keeping its invite link from them.

## To confirm

The maintainer has to:

1. **Decide who runs the public Relay, and where**, from the options above, or decide to run none. Then deploy the image `ghcr.io/adrianeyre/soundcheck/relay:latest` there, behind TLS.
2. **Make the image public** if the host pulls it without logging in (GitHub → the package → Package settings → Change visibility). GitHub makes a newly published package private.
3. **Set the repository variable `RELAY_URL`** to its `wss://` address (Settings → Secrets and variables → Actions → Variables). The next Desktop App release and Browser Version deploy start with it.
4. **Check by hand**, which this sandbox couldn't do (no Docker, no host, no second machine):
   - CI's `relay` job builds the image and it starts.
   - The deployed Relay answers `https://<address>/` with `Soundcheck Relay`.
   - Two machines in one Live Session through it see each other's edits within a second.
   - The Browser Version, from an invite link, joins that session.
