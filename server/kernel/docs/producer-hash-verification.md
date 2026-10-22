# Producer element hash verification

O11 canonical element text is checked against exact MD5/GUID hashes using strict UTF-8, Windows-1252, and the ANSI code page of `CultureInfo.CurrentCulture.TextInfo.ANSICodePage`, without duplicate candidates or character replacement. The reader's ANSI code page need not match the remote publisher's. Additional candidates require evidence.

An older element order means a non-empty, non-zero GUID in the 36-character dashed `D` format written by O11, different from `ModelConstants.CurrentElementsOrderVersion`. This is a format/version distinction, not an allowlist of known server releases and not proof of integrity. Missing, malformed and current markers never excuse a divergent hash.

For that older-order family only, an element hash which cannot be re-derived is accepted **unverified**. Capture, listing, cache reuse and delivery retain its key (and name/path when available) and issue `PRODUCER_HASH_UNVERIFIED` through `highWarnings` and the standard delivery warning channel:

> the producer signature uses an older element order; N element hashes could not be re-derived and were accepted unverified

The suggested action is:

> Publish the producer with the current element order and capture its signature again to verify these element hashes.

A successful capture therefore does not assert that every element hash was verified. Existing producer identity, published-version, whole-file and before-merge checks remain independent requirements. Synthetic offline tests prove this handling, not the integrity of a remote producer or a live SSO session.