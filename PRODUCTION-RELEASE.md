# Production source of truth

The root `PRODUCTION-RELEASE.json` binds the production server images and
published Agent installers to their original source commits and tree IDs.
The consolidated release is tagged `ssam-v0.2.7-r43b`.

`main` is the source reference for the deployed release. Develop and qualify
changes on separate branches/worktrees. After an authorized deployment passes
verification, integrate its exact server and Agent trees, update this manifest,
and create a new immutable release tag. Do not retag an existing release or
replace a production source with an unqualified development branch.

Studio dependencies and private runtime configuration remain external to Git;
the image build pins and release digests identify the delivered binaries.
Historical source commits remain valid even though this integration commit is
newer than the deployed image labels. This consolidation does not rebuild or
redeploy production.
