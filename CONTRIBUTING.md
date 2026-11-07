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

Use [Conventional Commits](https://www.conventionalcommits.org/) for every commit message and pull request title:

```text
type(scope): summary
```

- **English is required** for the entire title, including the scope and summary.
- **A scope is required**. Start it with a lowercase English letter and use only lowercase English letters, digits, and hyphens.
- **The entire commit message must be a single title line**. Do not add a body, footers, trailers, or a second `-m` argument.
- **The complete title must be 72 characters or fewer**, including the type, scope, spaces, and punctuation.
- Keep the type and scope lowercase. Start the summary with a lowercase imperative verb, such as `add`, `fix`, `remove`, `update`, or `document`.
- Proper names and technical identifiers in the summary may retain their original capitalization, such as `Android`, `GitHub`, `SDK`, and `JAVA_HOME`.
- Do not end the title with a period or whitespace, and do not use emoji.
- Keep each commit focused on one logical change. Describe the actual change; avoid vague summaries such as `update code` or `fix bug`.
- For an incompatible change, put `!` after the scope and before the colon: `type(scope)!: summary`.
- Put context, issue references, validation details, and migration notes in the pull request description.
- Apply the same rules to pull request titles and final squash-merge commit messages. When squash-merging, keep only the title and remove any automatically generated body or trailers.

Use one of these types:

| Type | Use for |
| --- | --- |
| `feat` | New user-visible functionality |
| `fix` | Bug, regression, or compatibility fixes |
| `refactor` | Code restructuring without behavior changes |
| `ui` | Visual styling or interaction adjustments |
| `perf` | Performance improvements |
| `docs` | Documentation changes |
| `test` | Test additions or updates |
| `build` | Build configuration, dependencies, tooling, or packaging |
| `ci` | CI workflows and automation |
| `chore` | Maintenance that fits no other type |
| `revert` | Reverting an earlier commit |

Use `feat` for new functionality and `fix` for defects, including changes to the UI. Use `ui` for other visual or interaction adjustments.

Preferred scopes:

| Scope | Area |
| --- | --- |
| `web` | Frontend pages, components, forms, and state |
| `api` | Backend endpoints, services, and request validation |
| `auth` | Login, sessions, roles, and access control |
| `sync` | Organization and user synchronization and matching |
| `meeting` | Meeting booking, allocation, invitations, and cancellation |
| `calendar` | Schedules, calendar integration, and event descriptions |
| `pool` | Advanced meeting accounts and account pools |
| `recording` | Recording links, synchronization, retention, and deletion |
| `config` | Configuration loading and first-run defaults |
| `db` | Database schemas, indexes, and migrations |
| `logs` | Log statistics and operation records |
| `tools` | Local startup, backup, upgrade, and maintenance scripts |
| `deploy` | Docker, Nginx, systemd, and deployment configuration |
| `build` | Build configuration, dependencies, tooling, and packaging |
| `ci` | CI workflows and automation |
| `docs` | README files and project documentation |
| `repo` | Repository-level configuration and contribution guidelines |

Prefer the scopes listed above. Use another concise scope only for a distinct area not covered by them, and keep it consistent. Tests should normally use the scope of the code they cover.

Examples:

```text
feat(meeting): add rescheduling for scheduled meetings
fix(sync): skip disabling unactivated removed users
fix(web): preserve booking scroll when switching platforms
docs(repo): simplify the bilingual README
feat(api)!: change the meeting payload
```

The existing [commit-msg hook](./.githooks/commit-msg) checks the title format, allowed types, length, and single-line rule. Enable the repository hooks with `npm run prepare`.

## Pull requests

- Keep changes focused and explain the problem they solve.
- Add or update tests when behavior changes.
- Include a screenshot or short recording for visible UI changes.
- Update user-facing documentation when configuration or behavior changes.
- Do not include credentials, `.properties` files, databases, logs, backups or other runtime data.
- Report security-sensitive issues privately instead of opening a public issue with exploit details.

## License

By contributing, you agree that your contribution is licensed under the [Apache License 2.0](./LICENSE).
