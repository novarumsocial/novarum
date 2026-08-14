---
title: 'Admin CLI'
description: 'CLI usage instructions'
---

The CLI is a useful tool to interact with Anchor and perform various tasks.

The usual way to run the CLI is inside the docker container and executing the Anchor binary:

```bash
docker exec -it anchor ./anchor cli <command> [options]
```

## Promoting and demoting as homeserver admin

- To promote: `promote-admin <username>`
- To demote: `demote-admin <username>`

This will allow access to the admin panel for the given user. Use carefully!

## Update migrations

### Computing avatar colors

A new feature has been added to compute avatar colors based on the user's avatar image.  
To calculate existing avatars, run `compute-avatar-color` with no option. It will take a few seconds, but when it's done voice channels should look better.

### WEBP reprocessing

User profile pictures, banners and guild icons are now stored in webp to save space and bandwith. To reprocess existing images, run `reprocess-webp` with no option. Note that it will take a bit!

:::note
Realtime user changes aren't sent to simplify the code, so real changes will only be visible after all clients have refreshed their app.
:::