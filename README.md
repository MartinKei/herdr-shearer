<p align="center">
  <img src="docs/app-icon.png" width="160" alt="herdr-shearer icon" />
</p>

# herdr-shearer

herdr-shearer is a desktop tool for herdr. It shows all spaces (workspaces), tabs and panes. You mark the items you do not need, and then close them in one step.

The app runs on macOS and Linux. It uses [Tauri](https://tauri.app/), with a Rust backend and a TypeScript user interface.

## Features

- Two columns: spaces on the left, tabs on the right.
- Click a tab to show its panes.
- Mark a space, a tab or a pane with the trash button.
- Marking a space marks its tabs and panes. Unmarking a pane unmarks its tab and space.
- **Close selected** asks for confirmation, then closes the marked items.
- Closing runs in this order: panes, tabs, spaces.
- **Refresh** reloads the lists from herdr. Marks stay on items that still exist.
- **Settings** sets the theme to System, Light or Dark. The choice is saved.

## Requirements

- [herdr](https://herdr.dev) installed, with the `herdr` command on the `PATH`.
- [Node.js](https://nodejs.org/) with npm.
- [Rust](https://www.rust-lang.org/tools/install) with Cargo.
- The Tauri system dependencies for your platform. See the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

## Development

Install the dependencies once:

```sh
npm install
```

Start the app in development mode:

```sh
npm run tauri dev
```

## Production build

```sh
npm run tauri build
```

The bundles are created in `src-tauri/target/release/bundle/`. A macOS build creates a `.app` and a `.dmg`. A Linux build creates the bundles for Linux. Build on Linux to get a Linux bundle.

## Notes

- The macOS build is not signed or notarised. Right-click the app and choose **Open** on first start.
- Closing a pane stops the process in it. This cannot be undone.

## Image credit

The app icon is a cropped version of this photo:

- Photo: [Technologie Gerät Werkzeug Elektrisch](https://www.pexels.com/de-de/foto/technologie-gerat-werkzeug-elektrisch-13386929/) on Pexels
- Photographer: Rafael Quaty

## License

herdr-shearer is free software under the [GNU General Public License v3.0](LICENSE). See the [LICENSE](LICENSE) file for the full text.
