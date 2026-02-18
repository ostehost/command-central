# Installation Guide - Ghostty Launcher for VS Code

This guide covers all installation methods for end users (non-developers) who want to use the Ghostty Launcher extension.

## 📋 Prerequisites

Before installing the extension, you need:

1. **macOS 12.0+** (required for app bundle creation)
2. **VS Code 1.100.0+** (check: Code → About Visual Studio Code)
3. **Ghostty Terminal** installed from [ghostty.org](https://ghostty.org)
4. **Ghostty Dock Launcher Script** (see setup below)

## 🚀 Installation Methods

### Method 1: Install from VSIX File (Recommended for Now)

Since the extension is not yet published to the VS Code Marketplace, use the VSIX file:

#### Option A: Command Line Installation
```bash
# If you have the VSIX file
code --install-extension dist/ghostty-launcher.vsix
```

#### Option B: GUI Installation
1. Open VS Code
2. Go to Extensions view (⌘⇧X)
3. Click the "..." menu at the top of Extensions panel
4. Select "Install from VSIX..."
5. Browse to and select the `ghostty-launcher.vsix` file
6. Click "Install"

#### Option C: Drag and Drop
1. Open VS Code
2. Open the Extensions view (⌘⇧X)
3. Drag the `ghostty-launcher.vsix` file into the Extensions panel
4. Click "Install" when prompted

### Method 2: From VS Code Marketplace (Future)

Once published, you'll be able to install directly:

1. Open VS Code
2. Press ⌘⇧X to open Extensions
3. Search for "Ghostty Launcher"
4. Click "Install"

Or via command line:
```bash
code --install-extension mike.ghostty-launcher
```

## 🔧 Initial Configuration

After installation, configure the extension:

### Step 1: Set Ghostty Launcher Path

1. Open VS Code Settings (⌘,)
2. Search for "ghostty launcher"
3. Set **Ghostty: Launcher Path** to your launcher script location
   - Default: `~/ghostty-dock-launcher-v1/ghostty`
   - Update to your actual path

### Step 2: Configure Project Icon (Optional)

Each project can have its own icon in the status bar:

1. Open a project in VS Code
2. Press ⌘⇧P for Command Palette
3. Run "Ghostty: Configure Project Settings"
4. Choose an emoji icon for your project

## ✅ Verify Installation

To verify the extension is working:

1. Open Command Palette (⌘⇧P)
2. Type "ghostty" - you should see these commands:
   - Ghostty: Launch Project Terminal
   - Ghostty: Launch Here
   - Ghostty: Launch at Workspace
   - Ghostty: Configure Project Settings
   - And more...

3. Check the status bar - you should see your project icon (if configured)

## 🎯 First Launch

To create your first launcher:

1. Open a project in VS Code
2. Press ⌘⇧P for Command Palette
3. Run "Ghostty: Launch Project Terminal"
4. If first time, you'll be prompted to:
   - Enter a project name
   - Choose an emoji icon
   - Select a terminal theme (optional)
5. The launcher will be created in `/Applications/Projects/`
6. Drag it to your dock for quick access!

## 🔍 Troubleshooting

### Extension Not Showing Commands

1. Ensure extension is enabled:
   - Go to Extensions (⌘⇧X)
   - Find "Ghostty Launcher"
   - Ensure it's enabled

2. Reload VS Code:
   - Press ⌘⇧P
   - Run "Developer: Reload Window"

### Launcher Script Not Found

1. Check the launcher path in settings:
   - Open Settings (⌘,)
   - Search for "ghostty launcher path"
   - Verify the path is correct

2. Install the launcher script:
   ```bash
   git clone https://github.com/ghostty-org/ghostty-dock-launcher-v1.git
   cd ghostty-dock-launcher-v1
   chmod +x ghostty
   # Note the full path
   pwd
   ```

3. Update the extension settings with the correct path

### Extension Not Activating

1. Check VS Code version (must be 1.100.0+):
   - Code → About Visual Studio Code

2. Check Output panel for errors:
   - View → Output
   - Select "Ghostty Launcher" from dropdown

### Permission Issues

If you get permission errors:

1. Make launcher script executable:
   ```bash
   chmod +x /path/to/ghostty-dock-launcher-v1/ghostty
   ```

2. Grant VS Code file access:
   - System Preferences → Security & Privacy → Privacy → Files and Folders
   - Ensure VS Code has access

## 📝 Updating the Extension

### From VSIX File

1. Get the new VSIX file
2. Run: `code --install-extension ghostty-launcher-new-version.vsix`
3. Reload VS Code when prompted

### From Marketplace (Future)

Updates will be automatic or prompted in VS Code.

## 🗑️ Uninstalling

### Remove Extension

1. Open Extensions (⌘⇧X)
2. Find "Ghostty Launcher"
3. Click the gear icon → Uninstall

Or via command line:
```bash
code --uninstall-extension mike.ghostty-launcher
```

### Remove Created Launchers

The launchers created by the extension are stored in:
```bash
/Applications/Projects/
```

To remove them:
1. Open Finder
2. Go to `/Applications/Projects/`
3. Delete the launcher apps you no longer need

## 📞 Getting Help

### Check Documentation
- Extension README in VS Code
- [GitHub Repository](https://github.com/mike/ghostty-launcher)
- Output panel: View → Output → "Ghostty Launcher"

### Report Issues
- [GitHub Issues](https://github.com/mike/ghostty-launcher/issues)
- Include VS Code version, macOS version, and error messages

## 🎉 Tips for Best Experience

1. **Pin to Dock**: Drag created launchers to your dock for instant access
2. **Use Project Icons**: Configure unique icons for easy visual identification
3. **Keyboard Shortcuts**: Set up custom keybindings for frequently used commands
4. **Multiple Projects**: Create launchers for all your active projects
5. **Theme Consistency**: Use the same Ghostty theme across related projects

## 🔒 Security Notes

- The extension only creates launchers in `/Applications/Projects/`
- All paths are sanitized to prevent injection attacks
- Workspace trust is respected - limited functionality in untrusted workspaces
- No telemetry or data collection
- Open source - audit the code yourself!

---

**Version**: 2.0.0  
**Last Updated**: November 2024  
**Compatible with**: VS Code 1.100.0+ on macOS 12.0+