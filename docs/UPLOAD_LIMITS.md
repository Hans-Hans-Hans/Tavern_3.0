# File sizes and storage quotas

An instance administrator can open **Admin → Storage**, choose **Maximum file
size (MiB)**, and select **Save storage policy**. Presets are 10, 25, 50, 100,
250 and 512 MiB; a custom value is also supported. The default remains **10 MiB**
until an administrator changes it. The maximum supported value is **512 MiB**.

The three controls have different purposes:

| Control | Meaning |
| --- | --- |
| Maximum file size | The largest individual new attachment. |
| Per-user quota | Total uploaded storage available to one account. Individual account overrides still apply. |
| Instance quota | Total original uploaded media across the instance. |

The maximum file size must fit the per-user quota, which must fit the instance
quota. Lowering a limit keeps existing files. New uploads use the saved limit
immediately, without requiring users to sign out. The client checks both the
current policy and Synapse's advertised maximum before encrypting a file; the
API independently checks actual bytes and reserves quota before forwarding it.

## One-time update for existing V3 installations

Rebuild **init**, **tavern-api** and **tavern-web** from the updated V3 source in
the **existing** stack. Run the updated initializer, then restart Synapse to
load its new ceiling. In Dockhand, refresh the existing V3 Git source and
rebuild/redeploy that stack, then restart Synapse after the initializer finishes.
Keep the same Compose project, environment and volumes.

For a local checkout that already controls the running stack, after pulling V3:

```sh
sudo docker compose build init tavern-api tavern-web
sudo docker compose run --rm --no-deps init
sudo docker compose restart synapse
sudo docker compose up -d --no-deps tavern-api tavern-web
```

Use the original Compose file selection if this deployment uses `-f` or
`COMPOSE_FILE`. A separate old checkout is not the running Dockhand deployment;
see [deployment source selection](DEPLOY_GITHUB.md#choose-the-source-and-compose-file).
These commands do not remove volumes. Ordinary later changes in Admin → Storage
do not require another rebuild or restart.

The initializer raises Tavern's old generated Synapse `max_upload_size: 10M`
to `512M`, preserving a copy at `synapse/homeserver.before-upload-limit.yaml`
inside the existing data volume. Other customized Synapse limits are preserved.
The admin page displays the running homeserver ceiling and explains when it is
lower than the selected policy. For a preserved custom limit, adjust
`max_upload_size` in the existing `homeserver.yaml` and restart Synapse.
[Synapse configuration reference](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#max_upload_size).

The internal gateway supports 512 MiB on the supported attachment upload routes.
Other API and Matrix request body limits remain bounded separately. The API
buffers at most two concurrent uploads in its private data volume instead of
the container's small RAM-backed `/tmp`; temporary buffers are removed on close.
Allow disk space for those buffers as well as the final Synapse media files.

## Reverse proxies and practical limits

Your public proxy can reject a request before it reaches Tavern. Raising an
admin setting cannot change Cloudflare's plan-dependent upload ceiling or the
maximum request body configured in your own Nginx Proxy Manager host. An HTTP
413 response usually identifies a size limit at one of those layers.
[Cloudflare's upload limits and 413 guidance](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/).

For an NPM host that permits the full application ceiling, its effective nginx
configuration needs `client_max_body_size 512m;` and timeouts suitable for the
connection speed. Check any existing Advanced configuration before adding a
duplicate directive. Cloudflare can still impose a lower ceiling. Tavern uses
MiB (1,048,576 bytes); a proxy advertising MB may use a different unit.

Explicit downloads and attachment forwarding support the larger files.
Automatic previews stay bounded at 20 MiB; larger media can be downloaded.
Large encrypted files require more browser memory, especially on phones.
The local retry queue retains a separate 100 MiB budget for original file
copies; larger files can be sent directly, then queued as small uploaded
descriptors. See [attachment retries](ATTACHMENT_RETRIES.md).

After updating, set a suitable limit, send an attachment above 10 MiB, and
download it from a second account/device. Test through the public hostname as
well as locally so that any external proxy ceiling is included.
