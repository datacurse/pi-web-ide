# Verification policy

- Do not add or modify tests, run test suites, or execute ad hoc test/assertion scripts unless the user explicitly requests it.
- Use typechecking, linting, builds, and diff inspection for verification instead. Do not run commands that also invoke tests.
- If tests seem necessary, ask first rather than running them automatically.

## Formatting

- Use Prettier (`.prettierrc.json`): two spaces, no tabs.
- Run `pnpm format` after code changes and `pnpm check` before finishing.
