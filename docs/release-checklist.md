# Moss Release Checklist

Use this checklist for every Moss release candidate before it is tagged,
published, or consumed by a product host.

## Required Verification

From the Moss repository root:

```bash
npm run verify
```

This must pass before the release is considered usable. It checks the
open-source boundary, builds all workspaces, typechecks source, and runs package
tests.

## Host Adapter Decision

Before announcing a release, decide whether host adapter changes are required.

No host adapter change should be needed when all of these are true:

- The release is a patch or minor version.
- `MOSS_HOST_ADAPTER_CONTRACT_VERSION` is unchanged.
- No new required capability kind is introduced.
- No new required event schema is introduced.
- No new required provider family is introduced.
- Existing public exports are preserved.

Host adapter changes are required when any of these are true:

- `MOSS_HOST_ADAPTER_CONTRACT_VERSION` changes incompatibly.
- A release requires a new host capability, event schema, or provider family.
- A host-owned surface such as provider configuration, approval handling, event
  delivery, workspace policy, device access, external channels, memory storage,
  or artifact delivery must change for Moss to work correctly.

Record the decision in release notes:

```text
Host adapter impact: none
```

or:

```text
Host adapter impact: required
Required host changes:
- Add capability ...
- Add event schema ...
```

## RDK Studio Consumption Check

When the release is intended to be consumed by RDK Studio, update the Studio
repository submodule and run:

```bash
npm run moss:update -- --ref <tag-or-commit>
```

That flow updates `external/moss`, rebuilds workspace packages when needed, and
runs the host adapter compatibility checks plus the Studio integration smoke.

For a verification-only pass after manually changing `external/moss`, run:

```bash
npm run moss:update:verify
```

## Release Notes Template

```text
Version:
Commit:

Summary:
- ...

Verification:
- npm run verify

Host adapter impact:
- none | required

RDK Studio consumption:
- npm run moss:update -- --ref <tag-or-commit>
- result: pass | not run
```
