# Publishing (npm + Homebridge) — reusable playbook

How this plugin ships, and the same recipe for any Node.js / Homebridge project.

## 0. One-time: npm account + auth
1. Create an account at https://npmjs.com (or use the org account).
2. **Local publish:** `npm login` (browser/OTP) then you can `npm publish`.
3. **CI publish (recommended):** create an **Automation** access token
   (npmjs.com → Access Tokens → Generate New Token → *Automation*), then add it to the GitHub
   repo as a secret named **`NPM_TOKEN`** (repo → Settings → Secrets → Actions → New secret).

## 1. Make the package publish-ready (Node.js)
- `name` unique + available (`npm view <name> version` → 404 means free).
- `version` follows semver; bump before each publish (`npm version patch|minor|major` also tags git).
- `main` points at the built entry (`dist/index.js`).
- **`files` whitelist** so only build output ships (no `src/`, tests, or secrets):
  `"files": ["dist", "config.schema.json", "LICENSE", "README.md"]` (+ `homebridge-ui` for a custom UI).
- `prepare`/`prepublishOnly` run the build so `dist/` exists at publish time.
- `LICENSE`, a real `README.md`, `repository`/`bugs`/`homepage`.
- Verify contents before publishing: `npm pack --dry-run` (eyeball the file list — no secrets!).

## 2. Homebridge-specific requirements
- Package name **must** start with `homebridge-` (or be a scoped `@scope/homebridge-*`).
- `package.json` keywords **must include `homebridge-plugin`** (this is how the UI finds it).
- `engines` declares supported `homebridge` + `node` ranges.
- Ship a **`config.schema.json`** so the plugin has a settings form in the Homebridge UI.
- Optional custom UI: a `homebridge-ui/` folder (+ `@homebridge/plugin-ui-utils` dep).

## 3. Publish
- **Manual:** `npm publish --access public` (first publish of an unscoped public package is public by default; scoped needs `--access public`).
- **Automated (this repo):** cut a **GitHub Release** (or push a `v*` tag) →
  `.github/workflows/publish.yml` runs build+test and `npm publish --provenance` using `NPM_TOKEN`.
- Recommended flow: `npm version minor` → `git push --follow-tags` → create the GitHub Release.

## 4. Homebridge Verified (optional, for the badge + featured listing)
Once it's on npm and stable, apply to the **Homebridge Verified** program:
- Requirements: MIT/Apache license, `config.schema.json`, no crashes on bad config, doesn't run as
  a fork of another plugin, uses child bridges where appropriate, maintained.
- Submit an issue at https://github.com/homebridge/verified following the template.
- Verified plugins get the ✓ badge and show higher in the Homebridge UI plugin search.

## 5. CI (this repo)
- `.github/workflows/ci.yml` — build + test on Node 18/20/22 for every push and PR.
- `.github/workflows/publish.yml` — publish to npm on GitHub Release / `v*` tag.

## Applying this to other projects
- **Non-Homebridge Node libs:** steps 0, 1, 3, 5 — skip the `homebridge-*` naming and `config.schema.json`.
- **Private packages:** publish to a private registry or GitHub Packages, or `"private": true` to prevent publish.
- **CLIs:** add a `bin` field; consumers get the command on global install.
