# get-jitney

Deploy [Jitney](https://github.com/LoriKarikari/jitney) to your Cloudflare account and configure its GitHub App.

```bash
npx get-jitney deploy
```

The installer deploys through Cloudflare's APIs using its embedded lifecycle
engine. Users do not need Wrangler, Docker, or a separate Alchemy installation.

Use `--organization YOUR_ORG` to register the GitHub App under an organization.
If setup fails, Jitney rolls back every recorded resource. Pass
`--keep-partial` to leave the installing receipt and resources for repair.

Deployments created by 0.2.x must be removed before their names can be reused.
See the [reinstall steps](https://github.com/LoriKarikari/jitney/blob/main/docs/operations/reinstall-pre-receipt-deployment.md).
