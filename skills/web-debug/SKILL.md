Use SamStack to inspect, interact with, and visually debug websites through a persistent Playwright browser runtime.

Core workflow:
1. Open the page with `{{SAMSTACK_INVOCATION}} goto <url>`
2. Inspect structure with `{{SAMSTACK_INVOCATION}} snapshot -i` or `{{SAMSTACK_INVOCATION}} text`
3. Use refs like `@e1` from `snapshot -i` for `click`, `fill`, `hover`, `wait`, and `upload`
4. Use `{{SAMSTACK_INVOCATION}} console`, `{{SAMSTACK_INVOCATION}} network`, and `{{SAMSTACK_INVOCATION}} cookies` to debug runtime behavior
5. Use `{{SAMSTACK_INVOCATION}} screenshot`, `{{SAMSTACK_INVOCATION}} snapshot -a`, and `{{SAMSTACK_INVOCATION}} responsive` for visual QA
6. Finish with `{{SAMSTACK_INVOCATION}} stop` so the server shuts down cleanly

Common commands:
- `{{SAMSTACK_INVOCATION}} goto https://example.com`
- `{{SAMSTACK_INVOCATION}} snapshot -i`
- `{{SAMSTACK_INVOCATION}} click @e3`
- `{{SAMSTACK_INVOCATION}} fill @e4 "hello@example.com"`
- `{{SAMSTACK_INVOCATION}} text`
- `{{SAMSTACK_INVOCATION}} screenshot`
- `{{SAMSTACK_INVOCATION}} snapshot -a`
- `{{SAMSTACK_INVOCATION}} responsive`
- `{{SAMSTACK_INVOCATION}} console --errors`
- `{{SAMSTACK_INVOCATION}} network`

Use this skill whenever you need autonomous browser analysis, evidence gathering, or visual debugging instead of raw HTML-only inspection.
