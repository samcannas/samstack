# SamStack

SamStack installs a persistent Playwright-based browser tool into AI coding harnesses like OpenCode, Claude Code, Codex CLI, Cursor, Gemini CLI, Kiro, and `.agents`-style setups.

It gives those hosts a shared `samstack-web-debug` skill that can browse sites, inspect structure, click/fill elements, capture screenshots, run responsive checks, and collect console/network evidence.

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
- After install, run Gemini's skills listing command to confirm `samstack-web-debug` is visible.

License note:

- SamStack is MIT licensed.
- It includes adapted MIT-licensed browser/runtime code derived from `garrytan/gstack`.
- The upstream license text is included in `UPSTREAM_LICENSE` to satisfy MIT notice requirements.
