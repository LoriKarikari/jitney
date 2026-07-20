# get-jitney

Install [Jitney](https://github.com/LoriKarikari/jitney) in your Cloudflare account and connect it to GitHub.

```bash
npx get-jitney deploy
```

The installer handles the Cloudflare and GitHub setup. You do not need Docker or another deployment tool.

Use `--organization YOUR_ORG` to create the GitHub App under an organization. If setup fails, Jitney removes the resources it recorded. Pass `--keep-partial` to leave the failed deployment in place instead.
