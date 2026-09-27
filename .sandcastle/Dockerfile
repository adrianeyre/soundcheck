# The sandbox image an agent runs inside.
#
# Four things Sandcastle needs and this file must keep: a non-root `agent` user
# (Claude Code refuses to run as root), `git` for the commits, `gh` for the
# issues, and `claude` on PATH.
#
# Node is pinned to 26 because the workspace declares `"node": ">=26"` and CI
# runs 26. `engines` is a warning rather than a wall, so a sandbox on an older
# Node installs happily and then fails somewhere further in — a much worse place
# to find out. If that line moves, move this one with it.
#
# Debian 13 (trixie) rather than 12: the ONNX Runtime that `ort` downloads for
# Stem Separation (ADR 0005) links against glibc 2.38 and GCC 13's libstdc++,
# which bookworm's 2.36 and GCC 12 don't have. CI's ubuntu-latest does.
FROM node:26-trixie

RUN apt-get update && apt-get install -y --no-install-recommends \
  git \
  curl \
  jq \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# What the desktop host (`desktop/`) links against on Linux, so the agent can
# build it and run its tests here: Tauri's webview and GTK, and ALSA for cpal
# and midir. There is no sound device in the sandbox; the tests don't need one.
# libjack-jackd2-dev is for cpal's JACK host (#68, which PipeWire also serves), and
# `file` is what the AppImage bundler shells out to (#71). `cmake` builds
# Steinberg's VST3 SDK and its example plugins, which the VST3 host is tested
# against (#69, #70); the base image already carries g++ and make.
RUN apt-get update && apt-get install -y --no-install-recommends \
  pkg-config \
  libwebkit2gtk-4.1-dev \
  libasound2-dev \
  libxdo-dev \
  libssl-dev \
  librsvg2-dev \
  libjack-jackd2-dev \
  cmake \
  file \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI — the agent reads the issue it is working and comments on it.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# pnpm, at the version the workspace pins.
#
# Corepack is what reads `packageManager` from package.json at run time, so this
# keeps one source of truth for pnpm's version instead of pinning it twice. Node
# stopped shipping corepack in the distribution as of 25, so it is installed
# rather than merely enabled — `corepack enable` alone is `not found` here.
RUN npm install -g corepack@latest && corepack enable

# UID/GID alignment. `sandcastle docker build-image` defaults these to the host
# user's, so files the image writes and files the bind mount writes share an
# owner and no runtime chown is needed. A mismatch here is the cause of
# "permission denied" on a file the agent just created.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's `node` user to `agent` and align its UID/GID.
RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/agent/.local/bin:$PATH"

# Rust, for the Audio Engine (ADR 0001): stable toolchain, the WASM target the
# browser dev host needs, and the components `pnpm lint` runs. wasm-pack itself
# is an npm devDependency, so the workspace pins it and no second copy lives
# here. The base image already carries the C toolchain rustc links with.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal \
    --component clippy,rustfmt \
    --target wasm32-unknown-unknown
ENV PATH="/home/agent/.cargo/bin:$PATH"

# Sandcastle bind-mounts the git worktree here and makes it the working
# directory at container start, so this has to be able to serve as the
# project root.
WORKDIR /home/agent/workspace

ENTRYPOINT ["sleep", "infinity"]
