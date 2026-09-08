# Tavern_3.0 — open in VS Code and push

This ZIP includes all application source, Dockerfiles, Compose definitions,
locked dependencies, tests, and guides. Generated dependencies/build output,
private instance data, credentials, and Git history are intentionally excluded.
Docker builds install dependencies and generate the web and conference assets.

## Push from your PC

Create an empty GitHub repository named `Hans-Hans-Hans/Tavern_3.0` if it does
not exist. Do not initialize it with a README, license, or .gitignore. For the
included unauthenticated remote Git builds, the repository must be public.
A private repository can use the local-source `compose.yaml` workflow instead,
or separately configured BuildKit Git authentication.

Extract the ZIP and open the inner `Tavern_3.0` folder in VS Code. Open
Terminal > New Terminal. With Git installed and your GitHub account authorized
to push to the repository, run these commands in that folder:

```sh
git init -b V3
git add .
git commit -m "Initial Tavern Matrix source and Docker deployment"
git remote add origin https://github.com/Hans-Hans-Hans/Tavern_3.0.git
git push -u origin V3
```

Complete GitHub's browser sign-in if Git prompts for authentication. If Git asks
for your author name/email, configure your own Git identity and rerun the commit.
If the remote branch already contains commits, inspect them before proceeding;
do not force-push over existing work.

## Deploy with Dockhand

Repository: `https://github.com/Hans-Hans-Hans/Tavern_3.0.git`
Branch: `V3`
Compose path: `compose.github.yaml`
Build images on deploy: On

Read `docs/DEPLOY_GITHUB.md` for the one-time private configuration, NPM routing,
and DNS setup. After provisioning calls and the bot, `compose.github.full.yaml`
provides the complete seven-service stack in one Compose file. Its Git contexts
also point to `Tavern_3.0`, with `TAVERN_GIT_REF=V3` by default.

For a local frontend test, use Node.js 22.13 or newer:

```sh
npm ci
npm run dev
```

Use the local URL printed by Vite. Real messaging requires a Matrix homeserver;
frontend startup alone does not provision Synapse, accounts, calls, or the bot.

See `SECURITY.md` and `docs/FEATURES.md` for actual capabilities and limitations.
Application version remains 0.3.0. No full feature-parity or production-security
certification is implied by the new repository name.
