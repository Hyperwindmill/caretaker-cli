/**
 * Electron main process for CareTaker desktop app.
 *
 * Responsibilities:
 * 1. Ensure ~/.caretaker/ data directory exists
 * 2. Start the Hono backend (packages/cli/dist/index.js) via utilityProcess.fork()
 * 3. Open a BrowserWindow pointing to http://127.0.0.1:PORT
 * 4. Implement a clean System Tray experience matching the old sister repository
 */

import { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, shell, utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import fs from "node:fs";
import net from "node:net";
import { activationScript, hasAssistantFlag, readAssistantConfig } from "./assistant.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  let PORT = parseInt(process.env.PORT || "0");
  const isPackaged = app.isPackaged;
  const appRoot = app.getAppPath(); // Dev: packages/desktop, Prod: root of ASAR

  // Resolve backend entry file based on packaged or development status
  const cliEntry = isPackaged
    ? path.resolve(appRoot, "packages", "cli", "dist", "index.js")
    : path.resolve(appRoot, "..", "cli", "dist", "index.js");

  function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const port = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(port));
      });
      srv.on("error", reject);
    });
  }

  const DATA_DIR = process.env.CARETAKER_HOME || path.join(os.homedir(), ".caretaker");

  let mainWindow: BrowserWindow | null = null;
  let backendProc: UtilityProcess | null = null;
  let tray: Tray | null = null;
  let isQuitting = false;

  function ensureDataDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  function loadAppIcon(): Electron.NativeImage | undefined {
    const iconPath = path.resolve(appRoot, "caretaker.png");
    try {
      if (fs.existsSync(iconPath)) {
        const buf = fs.readFileSync(iconPath);
        const img = nativeImage.createFromBuffer(buf);
        if (!img.isEmpty()) {
          return img;
        }
      }
    } catch (err) {
      console.error("[desktop] Failed to read/load app icon:", err);
    }
    return undefined;
  }

  function createTrayIcon(): Electron.NativeImage {
    try {
      const img = loadAppIcon();
      if (img) {
        return img.resize({ width: 32, height: 32 });
      }
    } catch {
      // Fall through to fallback
    }

    // Fallback: simple system tray dot icon
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABqklEQVR4nGNkIBHIaVr/xyf/6PpRRlLMI0oxIUspcQwTrSwnVi9OF1JiMTaAKzSwhgC1LcdnJoYDaGE5PrOZCCmgtSMIJkJaA7gD6OF7bHYx0dtydEewEKM4MtSPITYigOHL128M3759Z6hq6GZ49uIVg7uLHUNSbBgDAwMDg6mRHsPpc5cYGBgYGBYuXcuwbdd+ohzCiOwabMDWypQhOzWWISGzlOHHj58MDrYWDOlJkQyRifko6q6c3MGgY+5BlKUw8Oj6UUYmQsGflhjJ0DlhJsOPHz8ZGBgYGA4cPsHw8NFTBhYWogIPL5DTtP5P0BQ1FUWGq9dvoYhV1HdRbDkMEMyGzMzMVLOMLAfce/CIQVtDFc5nZGRk6GuvoZ8DFi9fz1CSn8bAxsbKwMDAwODn5QxnUwMQTAObt+9lUJCXYdi6Zh7Du3cfGN68e89Q29xLNQcwDkQhhAwGvi4gtQ1HTfDo+lHGgQ+BQeGAgYgGmJ1M6AL0tBzFAQMFUBxAj1BAtwMjBGjpCGxmY40CWjgCl5kELaK0qCbkGYKJkJLQIEYvyYZTu3sOAH6uloRBx5zYAAAAAElFTkSuQmCC";
    const fallbackPath = path.join(DATA_DIR, "tray-icon.png");
    try {
      fs.writeFileSync(fallbackPath, new Uint8Array(Buffer.from(base64, "base64")));
      const fallbackImg = nativeImage.createFromBuffer(fs.readFileSync(fallbackPath));
      return fallbackImg;
    } catch {
      return nativeImage.createEmpty();
    }
  }

  function startBackend(): Promise<void> {
    ensureDataDir();

    // Augment PATH with common binary directories
    const pathDelimiter = path.delimiter;
    const extraPaths = [
      path.join(os.homedir(), ".local", "bin"),
      path.join(os.homedir(), ".opencode", "bin"),
      path.join(os.homedir(), ".claude", "bin"),
      ...(os.platform() !== "win32" ? ["/usr/local/bin"] : []),
    ].join(pathDelimiter);
    const augmentedPath = `${extraPaths}${pathDelimiter}${process.env.PATH ?? ""}`;

    console.log(`[desktop] Spawning Hono backend via utilityProcess from: ${cliEntry}`);

    backendProc = utilityProcess.fork(cliEntry, ["web", "--port", String(PORT), "--host", "127.0.0.1"], {
      env: {
        ...process.env,
        PATH: augmentedPath,
        PORT: String(PORT),
        CARETAKER_HOME: DATA_DIR,
        NODE_ENV: "production",
      },
      stdio: "pipe",
    });

    backendProc.stdout?.on("data", (d: Buffer) =>
      process.stdout.write(`[backend] ${d}`)
    );
    backendProc.stderr?.on("data", (d: Buffer) =>
      process.stderr.write(`[backend] ${d}`)
    );

    // Poll port until the server is ready (up to 20 seconds)
    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      backendProc!.once("message", done);
      backendProc!.once("exit", (code) => {
        console.error(`[desktop] Backend process exited unexpectedly with code ${code}`);
        done();
      });

      const deadline = Date.now() + 20_000;
      const poll = () => {
        if (resolved) return;
        if (Date.now() > deadline) {
          console.warn("[desktop] Backend server port check timed out, launching UI anyway...");
          done();
          return;
        }
        const req = net.createConnection({ port: PORT, host: "127.0.0.1" });
        req.setTimeout(300);
        req.on("connect", () => {
          req.destroy();
          done();
        });
        req.on("error", () => {
          req.destroy();
          setTimeout(poll, 250);
        });
        req.on("timeout", () => {
          req.destroy();
          setTimeout(poll, 250);
        });
      };
      setTimeout(poll, 300);
    });
  }

  function createWindow() {
    const appIcon = loadAppIcon();

    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 640,
      title: "CareTaker",
      icon: appIcon,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

    // Open external links in default user system browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });

    mainWindow.on("close", (e) => {
      if (!isQuitting) {
        e.preventDefault();
        mainWindow!.hide();
      } else {
        mainWindow = null;
      }
    });

    // Register tray menu updates on window show/hide
    mainWindow.on("show", updateTrayMenu);
    mainWindow.on("hide", updateTrayMenu);

    // Refresh tray menu now that window is created
    updateTrayMenu();
  }

  function createTray() {
    tray = new Tray(createTrayIcon());
    tray.setToolTip("CareTaker");
    updateTrayMenu();

    // Toggle window visibility on click
    tray.on("click", () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });
  }

  function updateTrayMenu() {
    if (!tray) return;
    const visible = mainWindow?.isVisible() ?? false;
    const menu = Menu.buildFromTemplate([
      {
        label: visible ? "Hide" : "Show",
        click: () => {
          if (mainWindow) {
            if (mainWindow.isVisible()) {
              mainWindow.hide();
            } else {
              mainWindow.show();
              mainWindow.focus();
            }
          }
          updateTrayMenu();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  }

  const PORT_FILE = path.join(DATA_DIR, "port");
  const CONFIG_FILE = path.join(DATA_DIR, "caretaker.json");

  /** Single entry point for every assistant trigger (global shortcut,
   *  `--assistant` launch, a future wake word): bring the window up and hand
   *  the page an `assistantActivate` message. Feature off ⇒ no-op. */
  let activateWhenReady = false;
  function activateAssistant() {
    if (!mainWindow) {
      // Trigger arrived while the backend is still booting: replay it once
      // the window has loaded.
      activateWhenReady = true;
      return;
    }
    const cfg = readAssistantConfig(DATA_DIR);
    if (!cfg) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.executeJavaScript(activationScript(cfg.agentId)).catch((err) => {
      console.warn(`[assistant] activation failed: ${err}`);
    });
  }

  /** (Re)register the global shortcut from caretaker.json. One accelerator is
   *  ever registered, so unregisterAll is exact. A bad accelerator logs and
   *  moves on — it must never stop the app. Under Wayland the X11 grab never
   *  fires; the `--assistant` launch is the path there. */
  let registeredShortcut = "";
  function registerAssistantShortcut() {
    const cfg = readAssistantConfig(DATA_DIR);
    const next = cfg?.shortcut ?? "";
    if (next === registeredShortcut) return;
    globalShortcut.unregisterAll();
    registeredShortcut = "";
    if (!next) return;
    try {
      if (globalShortcut.register(next, activateAssistant)) registeredShortcut = next;
      else console.warn(`[assistant] shortcut "${next}" is taken by another application`);
    } catch (err) {
      console.warn(`[assistant] invalid shortcut "${next}": ${err}`);
    }
  }

  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
    // A desktop-environment keybinding launching `<app> --assistant` lands
    // here (the Wayland path: the DE launch carries the activation token).
    if (hasAssistantFlag(argv)) activateAssistant();
  });

  app.whenReady().then(async () => {
    if (PORT === 0) {
      PORT = await getFreePort();
    }

    ensureDataDir();
    fs.writeFileSync(PORT_FILE, String(PORT), "utf-8");

    // Hide standard application menu for pure app experience
    Menu.setApplicationMenu(null);

    // 1. Create the tray icon immediately to secure DBus AppIndicator registration on Linux
    createTray();

    // 2. Start the backend process
    await startBackend();

    // 3. Create the BrowserWindow
    createWindow();

    // 4. Desktop assistant: shortcut from config, re-read when the settings
    //    form saves. watchFile polls, so it survives the store's tmp+rename.
    // ponytail: 2 s poll of one file; fs.watch if latency ever matters.
    registerAssistantShortcut();
    fs.watchFile(CONFIG_FILE, { interval: 2000 }, registerAssistantShortcut);
    if (hasAssistantFlag(process.argv) || activateWhenReady) {
      activateWhenReady = false;
      mainWindow!.webContents.once("did-finish-load", activateAssistant);
    }

    app.on("activate", () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (isQuitting) {
      backendProc?.kill();
      backendProc = null;
    }
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    fs.unwatchFile(CONFIG_FILE);
  });

  app.on("before-quit", () => {
    isQuitting = true;
    backendProc?.kill();
    try {
      fs.unlinkSync(PORT_FILE);
    } catch {
      // ignore
    }
  });
}
