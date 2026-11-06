FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu git rsync \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

COPY deploy/dsh-work-entrypoint.sh /usr/local/bin/dsh-work-entrypoint.sh
RUN chmod 755 /usr/local/bin/dsh-work-entrypoint.sh

WORKDIR /work

ENTRYPOINT ["/usr/local/bin/dsh-work-entrypoint.sh"]
CMD ["pnpm", "--parallel", "--filter", "@dsh-work/server", "--filter", "@dsh-work/workbench-web", "--filter", "@dsh-work/admin-web", "dev"]
