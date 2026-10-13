# syntax=docker/dockerfile:1.7
#
# ssam-server: the HOSTED SSAM MCP (ssam serve without --local-studios) for a clean Linux server. One image holds the MCP
# (Node 24), the programs it runs on every call, the O11 kernel (anvil.dll), the ODC kernel (anvil-odc.dll) and the ODC
# builder/reader (ODC3.Builder.dll), and the part of each OutSystems Studio those programs compile against and load.
#
# The Studios come from the `installers` build context (compose passes docker/installers) in one of two forms: the
# OFFICIAL INSTALLER (read here and never run; or downloaded, pinned by SHA256) or, when it is absent, a STUDIO BUNDLE
# packed from an installed Studio (studio-bundle.ps1/.sh; every file checked against its SHA256SUMS). Only the files
# listed in studio-o11.txt and studio-odc.txt are kept (/studio/o11 and /studio/odc); the rest of each Studio (UI,
# Chromium, updater, Windows runtime) never enters a layer. The image therefore carries OutSystems binaries, as the
# bundles do: keep both in a private registry or store.
#
#   docker buildx build -f docker/ssam-server/Dockerfile --build-context installers=docker/installers -t ssam-server .
#
# The kernels target net8.0 with RollForward=Major and run on the .NET 10 runtime of this image, as on the Windows hosts
# (where only .NET 10 is installed): Service Studio 11.55.91 carries System.Text.Json and others at 10.0, which the O11
# kernel compiles against (kernel/Directory.Build.targets). A .NET 8 runtime next to it would be chosen first and would
# not satisfy those references, so the image has none.
# The XIF engine (o11_extension) is .NET Framework x86, Windows only: not built here, refused hosted (XIF_ENGINE_WINDOWS_ONLY).

ARG NODE_VERSION=24
ARG PNPM_VERSION=11.19.0
# Service Studio 11: the version of the customers' Studios (the O11 lane refuses another one, STUDIO_VERSION_MISMATCH).
# 11.55.92 on this line since 2026-10-12. The 11.55.91 inputs were ServiceStudio-11.55.91.65258.exe (SHA256
# 10047d31a03adbbe6bd3a07c9de0506eeba3420e7031e51846607ee3fcde136c) and o11-studio-11.55.91.65258.tar.gz; studio-o11.txt
# is the same list for both.
ARG SERVICE_STUDIO_INSTALLER=ServiceStudio-11.55.92.65269.exe
ARG SERVICE_STUDIO_SHA256=1d82f514e8ab7f78ba5dcef8eb618b6088a1793c1993db424f247c59d6efba49
ARG SERVICE_STUDIO_URL=
ARG SERVICE_STUDIO_BUNDLE=o11-studio-11.55.92.65269.tar.gz
ARG SERVICE_STUDIO_BUNDLE_SHA256=
# ODC Studio: the version of the customers' ODC Studio (the agent hub compares its first three numbers with kernel.json odc;
# 1.7.28 since the auto-update of 2026-10-12), and never older than 1.7.27 (the ODC kernel uses MobileSplashScreen, which
# 1.7.23 lacks). No SHA256 pinned yet. Its installer cannot be downloaded today: the studio bundle (studio-bundle.ps1 on
# a machine with ODC Studio installed) is the other input, used when the installer is absent.
ARG ODC_STUDIO_INSTALLER=ODCStudio-1.7.28.10850.exe
ARG ODC_STUDIO_SHA256=
ARG ODC_STUDIO_URL=
ARG ODC_STUDIO_BUNDLE=odc-studio-1.7.28.10850.tar.gz
ARG ODC_STUDIO_BUNDLE_SHA256=
# nsis: docker/ssam-server/nsis_extract.py (Python standard library); 7z: 7-Zip of the distribution.
ARG STUDIO_EXTRACTOR=nsis
# The Studio versions this image serves, three numbers each (multi-version design rev. 3, O.6.1): ENV SSAM_IMAGE_O11 and
# SSAM_IMAGE_ODC for the server (platforms/odc/facade/kernel-image.mjs: a lane whose kernel.json names another version is
# off, KERNEL_UNAVAILABLE) and the labels ssam.kernels.o11 / ssam.kernels.odc for the deploy checks. The runtime stage
# refuses to build when a Studio folder holds another version (kernel-image.mjs check-image). Change them with the Studios.
ARG SSAM_IMAGE_O11=11.55.92
ARG SSAM_IMAGE_ODC=1.7.28

# ---- The installers: the named build context `installers` replaces this empty stage --------------------------------------
FROM scratch AS installers

# ---- The reader of the installers ----------------------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS studio-reader
ARG STUDIO_EXTRACTOR
RUN if [ "$STUDIO_EXTRACTOR" = 7z ]; then \
      apt-get update && { apt-get install -y --no-install-recommends 7zip || apt-get install -y --no-install-recommends p7zip-full; } \
      && rm -rf /var/lib/apt/lists/*; fi
WORKDIR /reader
COPY docker/ssam-server/nsis_extract.py docker/ssam-server/studio_bundle.py docker/ssam-server/studio-extract.sh \
     docker/ssam-server/studio-o11.txt docker/ssam-server/studio-odc.txt ./

# ---- Service Studio 11 -> /studio/o11 -------------------------------------------------------------------------------------
FROM studio-reader AS studio-o11
ARG SERVICE_STUDIO_INSTALLER
ARG SERVICE_STUDIO_SHA256
ARG SERVICE_STUDIO_URL
ARG SERVICE_STUDIO_BUNDLE
ARG SERVICE_STUDIO_BUNDLE_SHA256
ARG STUDIO_EXTRACTOR
RUN --mount=type=bind,from=installers,target=/installers \
    STUDIO_EXTRACTOR="$STUDIO_EXTRACTOR" sh studio-extract.sh o11 "$SERVICE_STUDIO_INSTALLER" "$SERVICE_STUDIO_URL" \
      "$SERVICE_STUDIO_SHA256" ServiceStudio.Framework.dll studio-o11.txt /studio/o11 "$SERVICE_STUDIO_BUNDLE" "$SERVICE_STUDIO_BUNDLE_SHA256"

# ---- ODC Studio -> /studio/odc -----------------------------------------------------------------------------------------------
FROM studio-reader AS studio-odc
ARG ODC_STUDIO_INSTALLER
ARG ODC_STUDIO_SHA256
ARG ODC_STUDIO_URL
ARG ODC_STUDIO_BUNDLE
ARG ODC_STUDIO_BUNDLE_SHA256
ARG STUDIO_EXTRACTOR
RUN --mount=type=bind,from=installers,target=/installers \
    STUDIO_EXTRACTOR="$STUDIO_EXTRACTOR" sh studio-extract.sh odc "$ODC_STUDIO_INSTALLER" "$ODC_STUDIO_URL" \
      "$ODC_STUDIO_SHA256" OutSystems.ModelAPILoader.dll studio-odc.txt /studio/odc "$ODC_STUDIO_BUNDLE" "$ODC_STUDIO_BUNDLE_SHA256"

# ---- JavaScript dependencies (root + platforms/odc), lockfiles frozen --------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS js
ARG PNPM_VERSION
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml* ./
COPY platforms/odc/package.json platforms/odc/pnpm-lock.yaml* platforms/odc/
RUN pnpm install --frozen-lockfile --prod \
 && cd platforms/odc && pnpm install --frozen-lockfile --prod

# ---- O11 kernel (anvil.dll), against /studio/o11 ------------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS kernel-o11
WORKDIR /src
COPY kernel/ kernel/
RUN --mount=type=bind,from=studio-o11,source=/studio/o11,target=/studio/o11 \
    dotnet build kernel/src/Anvil.Cli -c Release -nologo -v q -nodeReuse:false \
      -p:SSDir=/studio/o11 -o /out/kernel/.local/cli

# ---- ODC kernel (anvil-odc.dll), against /studio/odc ----------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS kernel-odc
WORKDIR /src
COPY kernel/ kernel/
RUN --mount=type=bind,from=studio-odc,source=/studio/odc,target=/studio/odc \
    dotnet build kernel/src/Anvil.Cli.Odc -c Release -nologo -v q -nodeReuse:false \
      -p:OdcInstall=/studio/odc -o /out/kernel/.local/lane-odc/cli

# ---- ODC builder / reader (ODC3.Builder.dll), against /studio/odc ---------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS builder-odc
WORKDIR /src
# The builder links a few kernel sources (CandidateReceipt.cs, SecurityWarnings.cs) so both judge alike.
COPY kernel/ kernel/
COPY platforms/odc/studio/ platforms/odc/studio/
RUN --mount=type=bind,from=studio-odc,source=/studio/odc,target=/studio/odc \
    dotnet build platforms/odc/studio/builder/Builder.csproj -c Release -nologo -v q -nodeReuse:false \
      -p:OdcInstall=/studio/odc \
 && mkdir -p /out/platforms/odc/studio/builder/bin/Release \
 && cp -r platforms/odc/studio/builder/bin/Release/net10.0 /out/platforms/odc/studio/builder/bin/Release/

# ---- Runtime: Node 24 + .NET 10 + the SSAM tree + the two Studio folders ---------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS node
FROM mcr.microsoft.com/dotnet/runtime:10.0-noble AS runtime
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# libsqlite3 for the SQLite provider of the Studio model libraries: the installers ship only the Windows e_sqlite3.dll, so
# each Studio folder gets libe_sqlite3.so pointing at the distribution's library (DllImport "e_sqlite3" looks next to the
# assembly first). The .NET image already carries ICU (OML names, culture-aware compares).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsqlite3-0 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 ssam

COPY --from=studio-o11 /studio/o11 /studio/o11
COPY --from=studio-odc /studio/odc /studio/odc
RUN sqlite=$(find /usr/lib -name 'libsqlite3.so.0' | head -n 1) && test -n "$sqlite" \
 && ln -s "$sqlite" /studio/o11/libe_sqlite3.so && ln -s "$sqlite" /studio/odc/libe_sqlite3.so

WORKDIR /app
# The SSAM tree the MCP reads at run time: facade, catalog, kernel data and docs (team rules served by the MCP), scripts
# and the job suites with the proven examples of both lanes and their coverage matrices (served by ssam_reference /
# ssam_discover; the ODC ones run on the anonymized lane fixture). .dockerignore keeps out .git, .local, bin/obj,
# node_modules, docker/installers, .env, tests, evidence and everything that names a client (no client name ships: the guard
# platforms/odc/facade/tests/hosted-image-denylist.test.mjs reads this exact context against
# docker/ssam-server/client-denylist.json, which never ships itself).
COPY --chown=ssam:ssam . /app
COPY --from=js --chown=ssam:ssam /src/node_modules /app/node_modules
COPY --from=js --chown=ssam:ssam /src/platforms/odc/node_modules /app/platforms/odc/node_modules
COPY --from=kernel-o11 --chown=ssam:ssam /out/ /app/
COPY --from=kernel-odc --chown=ssam:ssam /out/ /app/
COPY --from=builder-odc --chown=ssam:ssam /out/ /app/

# The versions the image declares are the versions of its Studio folders (ServiceStudio.Framework.dll FileVersion).
ARG SSAM_IMAGE_O11
ARG SSAM_IMAGE_ODC
RUN node /app/platforms/odc/facade/kernel-image.mjs check-image "/studio/o11=${SSAM_IMAGE_O11}" "/studio/odc=${SSAM_IMAGE_ODC}"
ENV SSAM_IMAGE_O11=${SSAM_IMAGE_O11} \
    SSAM_IMAGE_ODC=${SSAM_IMAGE_ODC}
LABEL ssam.kernels.o11="${SSAM_IMAGE_O11}" \
      ssam.kernels.odc="${SSAM_IMAGE_ODC}"

# State and caches live in volumes, never in the image:
#   /data/server        tokens.json (SHA-256 of each token only), customers' workspaces, audit, server.log
#   /data/friction      the friction store
#   /data/odc-features  Features.xml (+ FeaturesOverride.xml) of an ODC Studio that signed in once: the ODC model asks
#                       its feature provider (aggregates, for one); the installer does not carry it
ENV SSAM_SERVER_DIR=/data/server \
    SSAM_FRICTION_DIR=/data/friction \
    ANVIL_STUDIO_DIR=/studio/o11 \
    ANVIL_ODC_STUDIO_DIR=/studio/odc \
    ANVIL_ODC_FEATURES_DIR=/data/odc-features \
    SSAM_NODE=/usr/local/bin/node \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    SSAM_PORT=7310 \
    SSAM_PUBLIC_HOST=
RUN mkdir -p /data/server /data/friction /data/odc-features && chown -R ssam:ssam /data
VOLUME ["/data/server", "/data/friction", "/data/odc-features"]

USER ssam
EXPOSE 7310

# Listens on 0.0.0.0 inside the container network only (--allow-remote: hosted mode behind a TLS tunnel or proxy the
# owner controls, e.g. the `tunnel` service of the compose file). SSAM_PUBLIC_HOST adds the public host name the tunnel
# answers for (Host/Origin check of http-server.mjs).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SSAM_PORT||7310)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run with an init process (compose `init: true` / docker run --init) so signals reach node and the kernel children are reaped.
CMD ["sh", "-c", "exec node facade/ssam.mjs serve --host 0.0.0.0 --allow-remote --port \"$SSAM_PORT\" --log-file /data/server/server.log ${SSAM_PUBLIC_HOST:+--public-host \"$SSAM_PUBLIC_HOST\"}"]
