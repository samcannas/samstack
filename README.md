# SamStack

SamStack is a collection of tools, skills, and agents I use across AI coding harnesses.

Right now it includes an installable web debugging toolchain for hosts like OpenCode, Claude Code, Codex CLI, Cursor, Gemini CLI, Kiro, and `.agents`-style setups.

## Repo layout

Top-level content folders:

- `agents/` - agent definitions and prompts
- `skills/` - reusable host-installable skills
- `tools/` - tool modules and related assets

The installer now reads installable module metadata from `tools/` and skill templates from `skills/` directly.

That is enough for the content side of SamStack right now.

Other top-level folders like `src/` and `scripts/` are still useful for the installer/runtime implementation, but you do not need another content folder unless you later want something like shared templates or docs.

## Install

```bash
npx samstack
```

You can also run it non-interactively:

```bash
npx samstack install --host opencode,claude-code,codex --module web-debug --scope project
```

## Lifecycle management

Running `npx samstack` again now lets you inspect and manage what is already installed.

SamStack tracks installed items with manifests plus content checksums so it can tell you whether something is:

- installed and up to date
- installed but outdated
- missing

Available commands:

```bash
npx samstack status --host opencode --module web-debug
npx samstack install --host opencode --module web-debug
npx samstack update --host opencode --module web-debug
npx samstack uninstall --host opencode --module web-debug
```

## Browser runtime

SamStack installs its browser runtime into `~/.samstack/runtime/browser` and writes host-specific skills into the correct folders for each supported tool.

You can invoke the embedded browser directly too:

```bash
npx samstack browser goto https://example.com
```

## Supported hosts

Current installer targets:

- OpenCode
- Claude Code
- Cursor
- Codex CLI
- Kiro
- Gemini CLI
- .agents-style harnesses

## Module

Current installer module:

- `web-debug` - Playwright site analysis, interaction, screenshots, responsive checks, and visual debugging

## Notes

Gemini note:

- Gemini CLI skill support may require enabling Skills in Gemini settings first.

License note:

- SamStack is MIT licensed.
- It includes adapted MIT-licensed browser/runtime code derived from `garrytan/gstack`.
- The upstream license text is included in `UPSTREAM_LICENSE` to satisfy MIT notice requirements.

Optional dependency note:

- Browser cookie import support now uses a non-native SQLite path, so normal `npm install` stays free of the deprecated `prebuild-install` warning.
- On Windows, some browsers may need to be closed before their cookie database can be copied safely.
