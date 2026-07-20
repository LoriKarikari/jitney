# get-jitney

Install [Jitney](https://github.com/LoriKarikari/jitney) in your Cloudflare account and connect it to GitHub.

```bash
npx get-jitney deploy
```

The installer handles the Cloudflare and GitHub setup. You do not need Docker or another deployment tool.

Use `--organization YOUR_ORG` to create the GitHub App under an organization. If setup fails, Jitney removes the resources it recorded. Pass `--keep-partial` to leave the failed deployment in place instead.

Jitney cannot adopt deployments created by version 0.2.x. Remove the old deployment before reusing its name; the [reinstall guide](https://github.com/LoriKarikari/jitney/blob/main/docs/operations/reinstall-pre-receipt-deployment.md) has the cleanup steps.
