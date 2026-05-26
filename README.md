# Problem Lifecycle

Dynatrace AppEngine app for triaging Davis problems with multi-segment
analytics. App ID: `my.problems.hub`.

---

## Prerequisites

- **Node.js** 16.13+ (v24 recommended by `dt-app`).
- **npm** 8+.
- A **Dynatrace tenant** with AppEngine enabled. Tenant URL has the
  form `https://<your-tenant>.apps.dynatrace.com`.
- A user with permission to deploy AppEngine apps (typically
  Administrator, or a custom role with `app-engine:apps:install`).

---

## 1. Clone and install

```bash
git clone git@github.com:mbdccoletta/Problem-Lifecycle.git
cd Problem-Lifecycle
npm install
```

---

## 2. Point the manifest at your tenant

Edit `app.config.json` and set `environmentUrl` to your tenant:

```json
{
  "environmentUrl": "https://<your-tenant>.apps.dynatrace.com",
  "app": {
    "id": "my.problems.hub",
    "version": "0.0.100",
    ...
  }
}
```

> **Do not change `app.id`.** It must stay `my.problems.hub`.

---

## 3. Bump the version

Before every deploy, increment `app.version` in `app.config.json`
(e.g. `0.0.100` → `0.0.101`). The tenant rejects re-publishing the
same version.

---

## 4. Run tests (optional but recommended)

```bash
npm test
```

---

## 5. Deploy

```bash
npm run deploy
```

First run opens a browser for OAuth. The token is cached in
`.dt-app/.tokens.json` (gitignored).

Expected output:

```
Building your app
Validating manifest
Compressing app artifact
Deploying the app
App is deployed
Open your deployed app: 'https://<your-tenant>/ui/apps/my.problems.hub'
Done.
```

---

## 6. Verify

Open the URL printed at the end of the deploy and confirm the version
shown in the UI matches `app.version` in `app.config.json`.

You can also run:

```bash
npm run info
```

to query the tenant for the currently installed version.

---

## Rollback

Revert to a previous version:

```bash
git checkout <previous-commit> -- app.config.json
npm run deploy
```

Or fully uninstall the app from the tenant:

```bash
npm run uninstall
```

---

## End-user permissions

After deploy, end users do not automatically see the app. A tenant
admin must bind a policy granting at least:

```
ALLOW app-engine:apps:run
  WHERE app-engine:appId = "my.problems.hub";
ALLOW storage:events:read,
      storage:system:read,
      storage:entities:read,
      storage:buckets:read,
      storage:filter-segments:read,
      document:documents:read;
```

To allow commenting, add:

```
ALLOW document:documents:write,
      environment-api:events:write;
```

Apply via **Settings → Account Management → Policies/Groups** and add
users to the group.

---

## Available scripts

| Script              | What it does                                         |
|---------------------|------------------------------------------------------|
| `npm start`         | Local dev server with HMR.                           |
| `npm run build`     | Production build into `dist/ui/`.                    |
| `npm run deploy`    | Build + upload + activate on the tenant.             |
| `npm run uninstall` | Remove the app from the tenant.                      |
| `npm run info`      | Show the version currently installed on the tenant.  |
| `npm test`          | Run the test suite once.                             |
| `npm run test:watch`| Run the test suite in watch mode.                    |

---

## Licence

See `LICENSE.txt`.
