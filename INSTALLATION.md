# Installing Command Central

Command Central is published as `oste.command-central` for VS Code-compatible
editors.

## Marketplace

Install from the editor's Extensions view by searching for **Command Central**,
or run:

```bash
code --install-extension oste.command-central
```

## Local VSIX

For an operator-provided VSIX:

```bash
code --install-extension /absolute/path/to/command-central.vsix
```

You can also choose **Extensions → … → Install from VSIX…** in VS Code. Do not
rely on a hand-maintained artifact filename; use the VSIX produced by the
current repository distribution flow.

## Verify

1. Open a Git repository in VS Code.
2. Confirm the Command Central activity-bar container appears.
3. Run **Agent Status: Discovery Diagnostics** from the Command Palette to
   inspect which process and lane-registry sources were actually accepted.

Process discovery works without Ghostty Launcher. Active registry input is
configured through `commandCentral.laneRegistry.files` and requires Work
Registry-backed rows carrying `project_ref`. Deprecated full launcher
`tasks.json` ingestion is disabled by default; enable
`commandCentral.legacyLauncherTasks.enabled` only for short-lived diagnostics.

## Troubleshooting

- Reload the editor window after installing or upgrading.
- Confirm the extension is enabled for the current profile/workspace.
- Use the discovery-details command rather than assuming a file was ingested.
- For bugs, include the extension version and redacted discovery diagnostics in
  an issue at https://github.com/ostehost/command-central/issues.
