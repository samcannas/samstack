# SamStack

SamStack is a collection of tools, skills, and agents I use across AI coding harnesses.

Right now it includes an installable web debugging toolchain for hosts like OpenCode, Claude Code, Codex CLI, Cursor, Gemini CLI, Kiro, and `.agents`-style setups.

## Install

```bash
npx samstack
```

You can also run it non-interactively:

```bash
npx samstack install --host opencode,claude-code,codex --module web-debug --scope project
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
