# Contributing

Thanks for taking the time to improve agenda-link.

## Development

Requirements: macOS or Linux, Git, Bash, Node.js **22.12+** and npm 10+.

```bash
npm ci
./run.sh --dev      # backend watch mode + Vite dev server
```

Before opening a pull request, run:

```bash
npm run check
npm run audit:repository
```

`npm run check` covers lint, type checks, server and web tests, production build and repository checks. End-to-end tests are optional and require a local Chrome:

```bash
npm run test:e2e
```

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
type(scope): summary
```

- Write the summary in English as a short imperative sentence: `add`, `fix`, `remove`, `update`.
- Keep it lower-case and do not end with a period.
- A scope is required. Use the affected area, for example `web`, `api`, `auth`, `sync`, `meeting`, `calendar`, `tools`, `docs` or `repo`.
- Write only one title line. Do not add a body or a second `-m`.
- Keep one logical change in one commit. Avoid mixing unrelated refactors, fixes and documentation.
- Mark an incompatible change with `!` before the colon, for example `feat(api)!: change the meeting payload`.

Common types:

| Type | Use for |
| --- | --- |
| `feat` | A user-visible feature |
| `fix` | A bug or compatibility fix |
| `refactor` | Code restructuring without changing behavior |
| `perf` | Performance work |
| `docs` | Documentation changes |
| `test` | Test additions or updates |
| `build` | Dependencies, packaging or build configuration |
| `ci` | CI workflows and automation |
| `chore` | Maintenance that fits no other type |
| `revert` | Reverting an earlier commit |

Examples:

```text
feat(meeting): add rescheduling for scheduled meetings
fix(sync): skip disabling unactivated removed users
fix(web): preserve booking scroll when switching platforms
docs: simplify the bilingual README
```

Pull request titles should follow the same convention when the project uses squash merges. The repository commit-msg hook enforces the scope, English-only title and single-line rule.

## Pull requests

- Keep changes focused and explain the problem they solve.
- Add or update tests when behavior changes.
- Include a screenshot or short recording for visible UI changes.
- Update user-facing documentation when configuration or behavior changes.
- Do not include credentials, `.properties` files, databases, logs, backups or other runtime data.
- Report security-sensitive issues privately instead of opening a public issue with exploit details.

## License

By contributing, you agree that your contribution is licensed under the [Apache License 2.0](./LICENSE).
