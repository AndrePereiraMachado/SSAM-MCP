# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
#
# ssam-server, PRODUCTION image. Owned by the SSAM-MCP monorepo (it does not come from the server line). The hosted SSAM
# MCP (`ssam serve` without --local-studios) for a Linux VPS, behind the Caddy of deploy/compose.prod.yml; runbook in
# deploy/DEPLOY.md. Derived from the development Dockerfile docker/ssam-server/Dockerfile, which stays as it is, and built
# with the same scripts of docker/ssam-server (studio-extract.sh, studio_bundle.py, nsis_extract.py, studio-<lane>.txt).
# What production adds:
#   - every base image pinned by exact tag AND index digest (resolved on 2026-10-10 with `docker buildx imagetools
#     inspect`); to upgrade one, resolve the new tag the same way and change its ARG below;
#   - the Studios only from a pinned input: the build stops when the installer or bundle it is about to use has no SHA256
#     build arg (REQUIRE_PINNED_STUDIOS=0 turns that off, for a test build only);
#   - @modelcontextprotocol/client installed (see the js stage), without which no MCP session opens;
#   - the runtime runs as uid/gid 10001 (ssam) with the code root-owned: ssam writes only the state volumes, /tmp and the
#     runtime caches the server keeps inside its own tree (see "Writable by ssam" below);
#   - HEALTHCHECK on /health; run it with an init (compose `init: true`, or `docker run --init`) so signals reach node and
#     the kernel processes are reaped;
#   - OCI labels; no secret; nothing in the runtime beyond the base image, node and libsqlite3-0.
#
# Build it with deploy/build.sh, the only documented way: it runs the client-name guard
# (platforms/odc/facade/tests/hosted-image-denylist.test.mjs) first and builds only when no client name would ship. It
# runs, from this folder (server/), with the Studios through the `installers` named context:
#   docker buildx build -f Dockerfile --build-context installers=docker/installers \
#     --build-arg ODC_STUDIO_BUNDLE_SHA256=<sha256> --build-arg SERVICE_STUDIO_BUNDLE_SHA256=<sha256> \
#     --build-arg SSAM_VERSION=prod-<yyyymmdd>-<commit> --build-arg VCS_REF=<commit> --build-arg BUILD_DATE=<utc iso> \
#     --platform linux/amd64 -t ssam-server:prod-<yyyymmdd>-<commit> .
#
# LICENSE: the image carries OutSystems binaries (the part of each Studio the kernels compile against and load), like the
# studio bundles. Keep it in a PRIVATE registry or store; never push it to a public one.

# ---- Pinned base images (tag@index digest) --------------------------------------------------------------------------------
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG PYTHON_IMAGE=python:3.12.15-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
ARG DOTNET_SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0.401-noble@sha256:e70cdb7f80b0348f5cb85f19a8f670fca061f033d57eed12fa003d58b0e06317
ARG DOTNET_RUNTIME_IMAGE=mcr.microsoft.com/dotnet/runtime:10.0.12-noble@sha256:b89586dc17781f25531909993658aa8161205ae38b8cec8847df4a8221a403d5
ARG PNPM_VERSION=11.19.0

# ---- Studios: same build args and defaults as the development Dockerfile ----------------------------------------------------
# Service Studio 11: the version of the customers' Studios (the O11 lane refuses another one, STUDIO_VERSION_MISMATCH).
ARG SERVICE_STUDIO_INSTALLER=ServiceStudio-11.55.91.65258.exe
ARG SERVICE_STUDIO_SHA256=10047d31a03adbbe6bd3a07c9de0506eeba3420e7031e51846607ee3fcde136c
ARG SERVICE_STUDIO_URL=
ARG SERVICE_STUDIO_BUNDLE=o11-studio-11.55.91.65258.tar.gz
ARG SERVICE_STUDIO_BUNDLE_SHA256=
# ODC Studio 1.7.27 or newer. Its installer cannot be downloaded today: the studio bundle (studio-bundle.ps1 on a machine
# with ODC Studio installed) is the input, and its SHA256 must be pinned here.
ARG ODC_STUDIO_INSTALLER=ODCStudio-1.7.27.10846.exe
ARG ODC_STUDIO_SHA256=
ARG ODC_STUDIO_URL=
ARG ODC_STUDIO_BUNDLE=odc-studio-1.7.27.10846.tar.gz
ARG ODC_STUDIO_BUNDLE_SHA256=
ARG STUDIO_EXTRACTOR=nsis
ARG REQUIRE_PINNED_STUDIOS=1

# ---- Labels -------------------------------------------------------------------------------------------------------------------
ARG SSAM_VERSION=unversioned
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown

# ---- The installers: the named build context `installers` replaces this empty stage ------------------------------------------
FROM scratch AS installers

# ---- The reader of the installers and bundles (build only) -------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS studio-reader
ARG STUDIO_EXTRACTOR
RUN if [ "$STUDIO_EXTRACTOR" = 7z ]; then \
      apt-get update && { apt-get install -y --no-install-recommends 7zip || apt-get install -y --no-install-recommends p7zip-full; } \
      && rm -rf /var/lib/apt/lists/*; fi
WORKDIR /reader
COPY docker/ssam-server/nsis_extract.py docker/ssam-server/studio_bundle.py docker/ssam-server/studio-extract.sh \
     docker/ssam-server/studio-o11.txt docker/ssam-server/studio-odc.txt ./
COPY <<'EOF' /reader/require-pinned.sh
#!/bin/sh
# require-pinned.sh <arg prefix> <installer> <url> <installer sha256> <bundle> <bundle sha256>
# Production rule: the Studio input studio-extract.sh is about to use (the installer, by URL or from the installers
# context; else the studio bundle) must have its SHA256 pinned by build arg. The refusal names the build arg. When neither
# input is in the context, studio-extract.sh reports that itself.
set -eu
prefix=$1 installer=$2 url=$3 sha=$4 bundle=$5 bundle_sha=$6
ctx=${INSTALLERS_DIR:-/installers}
if [ -n "$url" ] || [ -f "$ctx/$installer" ]; then
  [ -n "$sha" ] || { echo "ssam-server (prod): the installer $installer has no pinned SHA256; set the build arg ${prefix}_SHA256 (REQUIRE_PINNED_STUDIOS=0 only for a test build)" >&2; exit 1; }
elif [ -n "$bundle" ] && [ -f "$ctx/$bundle" ]; then
  [ -n "$bundle_sha" ] || { echo "ssam-server (prod): the studio bundle $bundle has no pinned SHA256; set the build arg ${prefix}_BUNDLE_SHA256 to the sha256 that studio-bundle.ps1 printed (its .sha256 file) (REQUIRE_PINNED_STUDIOS=0 only for a test build)" >&2; exit 1; }
fi
EOF

# ---- Service Studio 11 -> /studio/o11 -------------------------------------------------------------------------------------------
FROM studio-reader AS studio-o11
ARG SERVICE_STUDIO_INSTALLER
ARG SERVICE_STUDIO_SHA256
ARG SERVICE_STUDIO_URL
ARG SERVICE_STUDIO_BUNDLE
ARG SERVICE_STUDIO_BUNDLE_SHA256
ARG STUDIO_EXTRACTOR
ARG REQUIRE_PINNED_STUDIOS
RUN --mount=type=bind,from=installers,target=/installers \
    if [ "$REQUIRE_PINNED_STUDIOS" != 0 ]; then sh require-pinned.sh SERVICE_STUDIO "$SERVICE_STUDIO_INSTALLER" "$SERVICE_STUDIO_URL" \
      "$SERVICE_STUDIO_SHA256" "$SERVICE_STUDIO_BUNDLE" "$SERVICE_STUDIO_BUNDLE_SHA256"; fi \
 && STUDIO_EXTRACTOR="$STUDIO_EXTRACTOR" sh studio-extract.sh o11 "$SERVICE_STUDIO_INSTALLER" "$SERVICE_STUDIO_URL" \
      "$SERVICE_STUDIO_SHA256" ServiceStudio.Framework.dll studio-o11.txt /studio/o11 "$SERVICE_STUDIO_BUNDLE" "$SERVICE_STUDIO_BUNDLE_SHA256"

# ---- ODC Studio -> /studio/odc --------------------------------------------------------------------------------------------------
FROM studio-reader AS studio-odc
ARG ODC_STUDIO_INSTALLER
ARG ODC_STUDIO_SHA256
ARG ODC_STUDIO_URL
ARG ODC_STUDIO_BUNDLE
ARG ODC_STUDIO_BUNDLE_SHA256
ARG STUDIO_EXTRACTOR
ARG REQUIRE_PINNED_STUDIOS
RUN --mount=type=bind,from=installers,target=/installers \
    if [ "$REQUIRE_PINNED_STUDIOS" != 0 ]; then sh require-pinned.sh ODC_STUDIO "$ODC_STUDIO_INSTALLER" "$ODC_STUDIO_URL" \
      "$ODC_STUDIO_SHA256" "$ODC_STUDIO_BUNDLE" "$ODC_STUDIO_BUNDLE_SHA256"; fi \
 && STUDIO_EXTRACTOR="$STUDIO_EXTRACTOR" sh studio-extract.sh odc "$ODC_STUDIO_INSTALLER" "$ODC_STUDIO_URL" \
      "$ODC_STUDIO_SHA256" OutSystems.ModelAPILoader.dll studio-odc.txt /studio/odc "$ODC_STUDIO_BUNDLE" "$ODC_STUDIO_BUNDLE_SHA256"

# ---- JavaScript dependencies (root + platforms/odc), lockfiles frozen -----------------------------------------------------------
FROM ${NODE_IMAGE} AS js
ARG PNPM_VERSION
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml ./
COPY platforms/odc/package.json platforms/odc/pnpm-lock.yaml platforms/odc/
# platforms/odc is installed WITH its devDependencies: the hosted server imports @modelcontextprotocol/client at run time
# (createSsamServer, platforms/odc/facade/ssam.mjs) and platforms/odc/package.json declares it as a devDependency, so the
# `--prod` install of the development Dockerfile leaves it out and every MCP session fails. It is the only devDependency.
RUN pnpm install --frozen-lockfile --prod && mkdir -p node_modules \
 && cd platforms/odc && pnpm install --frozen-lockfile \
 && test -f node_modules/@modelcontextprotocol/client/package.json && test -f node_modules/@modelcontextprotocol/server/package.json

# ---- .NET build base: the kernel sources once, NuGet packages in a build cache ---------------------------------------------------
# One NuGet cache per stage (id=ssam-nuget-<stage>, sharing=locked): BuildKit runs the three .NET stages in parallel, and
# with one shared cache their restores extract the same package at the same time (seen in the first build on Docker
# Desktop: "Could not find file '/root/.nuget/packages/microsoft.aspnetcore.app.ref/8.0.31/<tmp>'"). NuGet's own lock
# lives in each container's /tmp, so it cannot coordinate them.
FROM ${DOTNET_SDK_IMAGE} AS sdk
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
WORKDIR /src
COPY kernel/ kernel/

# ---- O11 kernel (anvil.dll), against /studio/o11 -----------------------------------------------------------------------------------
FROM sdk AS kernel-o11
RUN --mount=type=bind,from=studio-o11,source=/studio/o11,target=/studio/o11 \
    --mount=type=cache,id=ssam-nuget-kernel-o11,sharing=locked,target=/root/.nuget/packages \
    dotnet build kernel/src/Anvil.Cli -c Release -nologo -v q -nodeReuse:false \
      -p:SSDir=/studio/o11 -o /out/kernel/.local/cli

# ---- ODC kernel (anvil-odc.dll), against /studio/odc ------------------------------------------------------------------------------
FROM sdk AS kernel-odc
RUN --mount=type=bind,from=studio-odc,source=/studio/odc,target=/studio/odc \
    --mount=type=cache,id=ssam-nuget-kernel-odc,sharing=locked,target=/root/.nuget/packages \
    dotnet build kernel/src/Anvil.Cli.Odc -c Release -nologo -v q -nodeReuse:false \
      -p:OdcInstall=/studio/odc -o /out/kernel/.local/lane-odc/cli

# ---- ODC builder / reader (ODC3.Builder.dll), against /studio/odc -------------------------------------------------------------------
FROM sdk AS builder-odc
# The builder links a few kernel sources (CandidateReceipt.cs, SecurityWarnings.cs) so both judge alike.
COPY platforms/odc/studio/ platforms/odc/studio/
RUN --mount=type=bind,from=studio-odc,source=/studio/odc,target=/studio/odc \
    --mount=type=cache,id=ssam-nuget-builder-odc,sharing=locked,target=/root/.nuget/packages \
    dotnet build platforms/odc/studio/builder/Builder.csproj -c Release -nologo -v q -nodeReuse:false \
      -p:OdcInstall=/studio/odc \
 && mkdir -p /out/platforms/odc/studio/builder/bin/Release \
 && cp -r platforms/odc/studio/builder/bin/Release/net10.0 /out/platforms/odc/studio/builder/bin/Release/

# ---- Runtime: .NET 10 runtime + Node 24 + the SSAM tree + the two Studio folders ------------------------------------------------
FROM ${NODE_IMAGE} AS node
FROM ${DOTNET_RUNTIME_IMAGE} AS runtime
ARG DOTNET_RUNTIME_IMAGE
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# libsqlite3-0 for the SQLite provider of the Studio model libraries (the Studios ship only the Windows e_sqlite3.dll); the
# .NET image already carries ICU, OpenSSL, CA certificates and tzdata. The ssam user has no home of its own: HOME is /tmp
# (below) and its passwd entry points there too, because the hosted kernel processes get a closed environment without HOME
# and .NET then falls back to the passwd home for its per-user folders.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsqlite3-0 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 ssam \
 && useradd --system --uid 10001 --gid 10001 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin ssam

COPY --from=studio-o11 /studio/o11 /studio/o11
COPY --from=studio-odc /studio/odc /studio/odc
RUN sqlite=$(find /usr/lib -name 'libsqlite3.so.0' | head -n 1) && test -n "$sqlite" \
 && ln -s "$sqlite" /studio/o11/libe_sqlite3.so && ln -s "$sqlite" /studio/odc/libe_sqlite3.so

WORKDIR /app
# The SSAM tree the MCP reads at run time (facade, catalogs, kernel data, docs served by the MCP, the job suites with the
# proven examples), root-owned. .dockerignore keeps out .git, .local, bin/obj, node_modules, docker/installers, .env, tests,
# evidence, everything that names a client, and this Dockerfile and deploy/ (the guard
# platforms/odc/facade/tests/hosted-image-denylist.test.mjs reads exactly this context against
# docker/ssam-server/client-denylist.json, which never ships itself).
COPY . /app
COPY --from=js /src/node_modules /app/node_modules
COPY --from=js /src/platforms/odc/node_modules /app/platforms/odc/node_modules
COPY --from=kernel-o11 /out/ /app/
COPY --from=kernel-odc /out/ /app/
COPY --from=builder-odc /out/ /app/

# Writable by ssam (everything else under /app and /studio is root's and read-only for it):
#   /data/server, /data/friction, /data/odc-features   the state volumes (below)
#   /data/cache                                         the cache volume: module index and readers' copy (below)
#   /tmp                                                temp files, and HOME (per-user folders of .NET and the Studio libraries)
#   /app/.local, /app/platforms/odc/.local              caches the server line keeps inside its tree: discover index,
#                                                       debugger state (module index and readers: /data/cache)
#   /app/kernel/.local, /app/kernel/.local/lane-odc     locks, logs and work folders of the resident kernel workers, which the
#                                                       server line writes NEXT TO the compiled CLIs: root:ssam 1770 (sticky),
#                                                       so ssam adds files there but can neither replace nor rename the CLIs
#   /app/.local/authority (0700)                        ANVIL_AUTHORITY_DIR (below): the server's own trusted-controller key
#                                                       (bridge.key) of its resident ODC worker, builder and readers. Hosted
#                                                       child processes never get it: hostedSpawnEnv gives each customer
#                                                       <workspace>/state/relay-authority. Without the variable the kernel
#                                                       (.NET: LocalApplicationData, "" while ~/.local/share does not exist)
#                                                       and the facade (JS: $HOME/AppData/Local) disagree on the folder and
#                                                       the ODC worker dies at start on /app/kernel/Anvil (seen in the first
#                                                       rehearsal: warm "worker startup failed").
# Because of the last lines the container cannot run with a read-only root filesystem (deploy/compose.prod.yml).
# platforms/odc/studio/builder/features stays an EMPTY root-owned folder: .dockerignore keeps the builder's features out
# (owner's lab, client app logic), so Builder.csproj's `features\*.cs` compiled nothing; without the folder lib.mjs
# builderNeedsBuild() takes the builder for stale (missing glob folder), the warm skips the resident builder and a
# hosted call that needs it answers COMPONENT_STALE.
RUN install -d -o ssam -g ssam -m 0750 /data/server /data/friction /data/odc-features /data/cache /app/.local /app/platforms/odc/.local \
 && install -d -o ssam -g ssam -m 0700 /app/.local/authority \
 && install -d -m 0755 /app/platforms/odc/studio/builder/features \
 && chown root:ssam /app/kernel/.local /app/kernel/.local/lane-odc \
 && chmod 1770 /app/kernel/.local /app/kernel/.local/lane-odc

# State lives in volumes, never in the image:
#   /data/server        tokens.json (SHA-256 of each token only), kernel.json, customers' workspaces, audit, server.log
#   /data/friction      the friction store
#   /data/odc-features  Features.plain.xml: the feature cache of an ODC Studio that signed in once, decrypted on its Windows
#                       machine by deploy/odc-features-export.ps1 (the Windows Features.xml is DPAPI, unreadable here; the
#                       kernel encrypts the plain file with the Studio's Linux service, OdcFeatures.cs). The ODC model asks
#                       its feature provider; the installer does not carry it.
# And one cache volume, outside the backup (the server rebuilds it), kept across container recreations so an upgrade does
# not start cold, and emptied per customer offboarding (deploy/DEPLOY.md):
#   /data/cache         module-index/ (SSAM_MODULE_INDEX_ROOT: the ssam_map index and the module digests of the customers'
#                       captures) and readers/ (SSAM_READER_CACHE_ROOT: the resident readers' copy, one folder per build).
#                       Before, both lived in the container layer under /app/.local and were lost at every new container.
ENV HOME=/tmp \
    SSAM_SERVER_DIR=/data/server \
    SSAM_FRICTION_DIR=/data/friction \
    ANVIL_STUDIO_DIR=/studio/o11 \
    ANVIL_ODC_STUDIO_DIR=/studio/odc \
    ANVIL_ODC_FEATURES_DIR=/data/odc-features \
    ANVIL_AUTHORITY_DIR=/app/.local/authority \
    SSAM_MODULE_INDEX_ROOT=/data/cache/module-index \
    SSAM_READER_CACHE_ROOT=/data/cache/readers \
    SSAM_NODE=/usr/local/bin/node \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    SSAM_PORT=7310 \
    SSAM_PUBLIC_HOST=
VOLUME ["/data/server", "/data/friction", "/data/odc-features", "/data/cache"]

# The label values are declared only here: a build arg declared earlier in the stage is part of the cache key of every
# RUN after it, so a new BUILD_DATE rebuilt the apt layer and every runtime layer after it (seen in the Docker Desktop
# rehearsal: two builds of one tree shared none of them, ~600 MB more to push and pull). Now a release changes only the
# layers of its code.
ARG SSAM_VERSION
ARG VCS_REF
ARG BUILD_DATE
LABEL org.opencontainers.image.title="ssam-server" \
      org.opencontainers.image.description="SSAM hosted MCP server (production). Contains OutSystems Studio binaries: private registry only." \
      org.opencontainers.image.version="${SSAM_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="LicenseRef-Proprietary" \
      org.opencontainers.image.base.name="${DOTNET_RUNTIME_IMAGE}"

USER 10001:10001
EXPOSE 7310

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SSAM_PORT||7310)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Listens on 0.0.0.0 of the container network only (--allow-remote: hosted mode behind the TLS proxy the owner controls,
# the caddy service of deploy/compose.prod.yml, which publishes no port of this container). SSAM_PUBLIC_HOST is the public
# host name the proxy answers for (Origin check of http-server.mjs for browsers).
CMD ["sh", "-c", "exec node facade/ssam.mjs serve --host 0.0.0.0 --allow-remote --port \"$SSAM_PORT\" --log-file /data/server/server.log ${SSAM_PUBLIC_HOST:+--public-host \"$SSAM_PUBLIC_HOST\"}"]
