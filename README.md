# Moss

Moss is the open-source agent runtime extracted from RDK Studio.

This repository contains the host-neutral packages:

| Package | Role |
| --- | --- |
| `@dmoss/core` | Contracts, platform extension types, and robotics prompts |
| `@dmoss/agent` | Agent runtime, tool loop, context management, safety, skills, and provider adapters |
| `@dmoss/memory` | Context-aware memory selection and memory draft helpers |
| `@dmoss/skills` | Skill learning, validation, scoring, and promotion helpers |
| `@dmoss/teaching` | Teach-while-solve annotations and tool digest helpers |
| `create-dmoss-app` | Minimal project scaffolding for external Moss users |

RDK Studio is a product host for Moss. It is not part of this repository. Host-specific code such as device management, OpenClaw, Supabase ingestion, Electron UI, private provider defaults, Feishu/Weixin integrations, and RDK Studio configuration stays in the RDK Studio repository.

## Development

```bash
npm install
npm run verify
```

The open-source boundary is checked by:

```bash
npm run check:boundaries
```

## Host Boundary

Moss packages may define generic contracts and runtime behavior. Product hosts inject concrete providers, tools, storage, approval handling, knowledge modules, and UI/event transports.

This repository must not contain:

- RDK Studio host code from `server/**`, `src/**`, or `electron/**`
- RDK Studio private defaults such as `config/rdk-studio-*.defaults.json`
- Supabase/model/image keys, local sessions, logs, or device credentials
- Built artifacts committed from package `dist/` directories

RDK-specific domain knowledge can be published later as a separate optional package. The first migration keeps this repository focused on the host-neutral Moss runtime.
