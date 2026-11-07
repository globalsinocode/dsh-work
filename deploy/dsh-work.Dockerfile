# Modern Docker CLI (>=28.1) is required: the execution backend passes
# `--security-opt seccomp=builtin`, which older CLIs (Debian docker.io 20.10)
# misread as a profile file path.
FROM docker:cli AS docker-cli

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu git rsync ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

COPY deploy/dsh-work-entrypoint.sh /usr/local/bin/dsh-work-entrypoint.sh
RUN chmod 755 /usr/local/bin/dsh-work-entrypoint.sh

WORKDIR /work

ENTRYPOINT ["/usr/local/bin/dsh-work-entrypoint.sh"]
CMD ["pnpm", "--parallel", "--filter", "@dsh-work/server", "--filter", "@dsh-work/workbench-web", "--filter", "@dsh-work/admin-web", "dev"]
