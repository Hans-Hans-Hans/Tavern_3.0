# Contributing to Tavern V3

Target pull requests at **V3**, the Matrix implementation. The older FastAPI
application is a separate implementation; its database and accounts are not
migrated by this branch. See [the transition notes](docs/V3_MIGRATION.md).

Use Node.js 22.13 or newer and Python 3.12. Preserve `package-lock.json` and
`integrations/requirements.lock`; use `npm ci` for repeatable installs. Run the
commands under **Develop and verify** in the README and the repository check:

```sh
python3 scripts/check-repository.py
```

Keep changes focused, explain user-visible behavior and actual validation, and
update feature coverage. Changes to encryption, device trust, recovery, gateway
routes, or bot delivery require failure-path tests and a live acceptance
procedure. Unit tests alone do not establish production security.

Never commit instance configuration, tokens, recovery keys, message exports,
logs, databases, or generated assets. Use empty/redacted examples. `.gitignore`
cannot remove already tracked files or prevent `git add -f`; inspect
`git diff --cached` before committing. CI checks the tracked snapshot for ignored
files and selected credential patterns. It does not scan all inherited history
or detect every possible secret.

Docker contexts use allowlists. Explicitly add required new build inputs to the
appropriate `.dockerignore`, and test both image builds after changing them.

No project-wide Tavern license has been selected. Preserve existing third-party
notices and do not relabel dependencies. See [notices](THIRD_PARTY_NOTICES.md).
