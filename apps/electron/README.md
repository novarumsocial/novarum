# Novarum desktop

Electron shell for the frontend. Run all development services from the repository root:

```sh
bun run dev
```

Create desktop installers with `bun run --filter desktop build`.

## Development updates

Packaged clients check the GitHub `dev` channel on launch, showing the `/updater` frontend route
in a small window that downloads and installs any update before the main window opens. While
running they check every 30 minutes and download in the background; Settings → Desktop app (and
the tray menu) offer "Restart to update" once a download is ready.
The desktop release workflow publishes a SemVer prerelease for update ordering.

Automatic updates on macOS require these GitHub Actions secrets:

- `MAC_CSC_LINK`
- `MAC_CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
