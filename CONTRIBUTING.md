# Contributing

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Start Vite for UI work. |
| `npm run typecheck` | Strict TypeScript check. |
| `npm run lint` | ESLint over `src`, `tests`, and `scripts`. |
| `npm run lint:css` | Check that styles stay on the type scale. |
| `npm test` | Unit tests. |
| `npm run test:manual` | Live provider and embedding tests. These read credentials from the environment and skip without them. |
| `npm run build` | Type-check and build `dist/` without sourcemaps. |
| `npm run build:dev` | Build with sourcemaps. |
| `npm run check` | Lint, CSS check, unit tests, production build, and the bundle budget. |
| `npm run check:bundle` | Fail if the popup, finder, or service worker's startup payload in `dist/` outgrows its budget. |
| `npm run check:release` | `check`, then every browser smoke. Needs `BROWSER_PATH`; run it before a release. |

The smoke tests load the built extension in a real browser through Playwright. Set `BROWSER_PATH` to a Chromium-based browser executable first. They are the only end-to-end tests of the popup, settings page, and finder UI, and `npm run check` does not run them, so run `npm run check:release` before a release.

A UI module that takes its dependencies through a panel context can also be unit tested: start the test file with `// @vitest-environment happy-dom`, give the module a stub context, and stub `chrome` with `vi.stubGlobal`. `tests/usage-ui.test.ts` is the example.

| Command | What it covers |
|---|---|
| `npm run test:popup` | The main popup flow: organize, review, apply, undo, cleanup, search, and settings. |
| `npm run test:action-popup` | Popup width in compact and drawer layouts. |
| `npm run test:settings-direct` | Direct links into the settings page. |
| `npm run test:group-manager-ui` | The Groups view on real tab groups. |
| `npm run test:tab-search-ui` | Search filtering and the empty state. |
| `npm run test:stash-ui` | Workspaces: saving, linked windows, versions, trash, and recovery. |
| `npm run test:auto-file` | Auto-filing against mock decision-API and chat servers: save and verify, calibration import, filing, abstaining, Undo, user placement, group opt-out, and the organize suggestion. |
| `npm run test:finder` | The search shortcut's finder: filtering, the empty state, keyboard selection, switching tabs, and Escape. |
| `npm run test:smokes` | Every smoke above, one at a time, stopping at the first failure. |

## Releases

GitHub Actions ([`.github/workflows/build.yml`](.github/workflows/build.yml)) runs `npm run check` on every push to `main` and every pull request, and uploads the built extension as a zipped workflow artifact. The browser smokes don't run there, so run `npm run check:release` locally first.

To publish a release, bump `version` in both `package.json` and `public/manifest.json`, commit, then push a matching tag:

```sh
git tag v0.2.0
git push origin v0.2.0
```

The workflow fails if the tag doesn't match both versions. Otherwise it attaches `sheaf-<version>.zip` to a new GitHub release with generated notes. A tag with a hyphen, like `v0.2.0-beta.1`, is marked as a pre-release.

## Benchmark CLI

`npm run benchmark` compares prompt, model, and provider combinations on synthetic data. A generator model writes fresh tab sets, each candidate organizes them, and a separate grader model scores the results. Each candidate sets its own prompt, OpenAI-compatible endpoint, model, temperature, reasoning level, and extra request body.

The config controls how many datasets to generate, how many cases each holds, and how many times each candidate runs each case. Results rank candidates by grader score, with pass rate, latency, token usage, every input and response, and the grader's reasoning.

Copy [`benchmark.example.json`](benchmark.example.json), point `apiKeyEnv` at your environment variables, and run:

```sh
OPENAI_API_KEY=... OPENROUTER_API_KEY=... npm run benchmark -- --config benchmark.example.json --output benchmark-results.json
```

`--dry-run` validates the config and prints the expected number of calls without contacting any provider.

`--mode filing` runs the auto-filing benchmark instead: grouped windows from the configured corpora become held-out, distractor, and drifted-tab cases (some with adversarial titles), each decision-model candidate answers them in two option orders, and the report gives filing accuracy, false-file and false-move-out rates, calibration error, order flips, latency, and cross-validated thresholds against the ship gate. Add `--calibrations calibrations.json` to write those thresholds in the format **Settings → Auto-filing → Advanced → Import calibration** reads.

## Project layout

```text
src/background/   Service worker, transactions, recovery, linked workspaces, semantic indexing
src/benchmark/    Benchmark generation, evaluation, grading, and ranking
src/decision/     Auto-filing: decision requests, both wire protocols, the filing policy, triggers, and the filing log
src/browser/      Reading windows, planning operations, drift checks, protection, cleanup, workspaces, Undo
src/diagnostics/  Diagnostic event definitions
src/organizer/    Prompt, response validation, normalization, rules, proposal editing and diffs
src/privacy/      Sanitization, domain policy, request building
src/provider/     Provider requests, connection tests, request policy
src/search/       Direct search, embeddings, semantic indexing and ranking
src/shared/       Shared types, constants, and limits
src/storage/      Settings, session state, history, diagnostics, workspaces, backups
src/ui/           The popup, settings page, and finder, plus shared tokens and helpers
assets/           Icon source (the PNGs in public/icons are rendered from it) and README screenshots
tests/            Unit tests, plus manual tests against live providers
scripts/          Smoke harnesses, the benchmark CLI, and CSS checks
```
