# Reinstall a pre-receipt deployment

Jitney 0.3 introduces deployment receipts and ownership markers. Deployments
created by 0.2.x do not have either, so the new CLI refuses to adopt or
overwrite them. This is intentional: guessing ownership during the first
lifecycle-aware release would make uninstall unsafe.

Remove the old deployment once, then install it again:

1. Delete the old GitHub App in GitHub's developer settings. Deleting the App
   also removes its repository installations.
2. In the Cloudflare dashboard, delete the `<name>-runner` container
   application and the `<name>` Worker. The default name is `jitney`.
3. Remove the old `jitney:<version>` image from the account's container
   registry if it remains.
4. Run `npx get-jitney@latest deploy --name <name>`. Add `--organization
   <login>` if the App belongs to an organization.

Do not run the 0.3 installer under the old name until the Worker and container
application are gone. The installer treats either resource as an overwrite
attempt and stops before creating a receipt.
