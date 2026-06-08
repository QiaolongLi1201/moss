# Moss Release Checklist

Use this checklist for every Moss release candidate before it is tagged,
published, or consumed by a product host.

## Required Verification

From the Moss repository root:

```bash
npm run verify
npm run smoke:moss-cli
```

Both commands must pass before the release is considered usable. `npm run verify`
checks the open-source boundary, workspace hygiene, workspace builds,
typechecks, lint, and package tests. `npm run smoke:moss-cli` builds the CLI,
packs the current workspace tarballs, installs them into a temporary project,
checks the `moss` / `dmoss` / `dmoss-agent` bins, verifies packaged runtime
assets, blocks known deprecated install warnings, and opens the TUI through a
PTY when available.

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

## Downstream Host Consumption Check

When the release is intended to be consumed by a downstream host, update the
host repository dependency or vendored subtree and run its Moss upgrade flow:

```bash
npm run moss:update -- --ref <tag-or-commit>
```

That flow should update the consumed Moss code, rebuild workspace packages when
needed, and run the host adapter compatibility checks plus host integration
smoke tests.

For a verification-only pass after manually changing the consumed Moss code, run
the downstream host's Moss verification command, for example:

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
- npm run smoke:moss-cli

Host adapter impact:
- none | required

Downstream host consumption:
- npm run moss:update -- --ref <tag-or-commit>
- result: pass | not run
```
