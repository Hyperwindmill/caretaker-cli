/**
 * Electron main process for CareTaker desktop app.
 *
 * Responsibilities:
 * 1. Ensure ~/.caretaker/ data directory exists
 * 2. Start the Hono backend (packages/cli/dist/index.js) via utilityProcess.fork()
 * 3. Open a BrowserWindow pointing to http://127.0.0.1:PORT
 * 4. Implement a clean System Tray experience matching the old sister repository
 */
import { app, BrowserWindow, Menu, Tray, nativeImage, shell, utilityProcess } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import fs from "node:fs";
import net from "node:net";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
}
else {
    let PORT = parseInt(process.env.PORT || "0");
    const isPackaged = app.isPackaged;
    const appRoot = app.getAppPath(); // Dev: packages/desktop, Prod: root of ASAR
    // Resolve backend entry file based on packaged or development status
    const cliEntry = isPackaged
        ? path.resolve(appRoot, "packages", "cli", "dist", "index.js")
        : path.resolve(appRoot, "..", "cli", "dist", "index.js");
    function getFreePort() {
        return new Promise((resolve, reject) => {
            const srv = net.createServer();
            srv.listen(0, "127.0.0.1", () => {
                const port = srv.address().port;
                srv.close(() => resolve(port));
            });
            srv.on("error", reject);
        });
    }
    const DATA_DIR = process.env.CARETAKER_HOME || path.join(os.homedir(), ".caretaker");
    let mainWindow = null;
    let backendProc = null;
    let tray = null;
    let isQuitting = false;
    function ensureDataDir() {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    function createTrayIcon() {
        const iconPath = path.resolve(appRoot, "caretaker.png");
        try {
            if (fs.existsSync(iconPath)) {
                const img = nativeImage.createFromPath(iconPath);
                if (!img.isEmpty()) {
                    return img.resize({ width: 32, height: 32 });
                }
            }
        }
        catch {
            // Fall through to fallback
        }
        // Fallback: simple system tray dot icon
        const base64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABqklEQVR4nGNkIBHIaVr/xyf/6PpRRlLMI0oxIUspcQwTrSwnVi9OF1JiMTaAKzSwhgC1LcdnJoYDaGE5PrOZCCmgtSMIJkJaA7gD6OF7bHYx0dtydEewEKM4MtSPITYigOHL128M3759Z6hq6GZ49uIVg7uLHUNSbBgDAwMDg6mRHsPpc5cYGBgYGBYuXcuwbdd+ohzCiOwabMDWypQhOzWWISGzlOHHj58MDrYWDOlJkQyRifko6q6c3MGgY+5BlKUw8Oj6UUYmQsGflhjJ0DlhJsOPHz8ZGBgYGA4cPsHw8NFTBhYWogIPL5DTtP5P0BQ1FUWGq9dvoYhV1HdRbDkMEMyGzMzMVLOMLAfce/CIQVtDFc5nZGRk6GuvoZ8DFi9fz1CSn8bAxsbKwMDAwODn5QxnUwMQTAObt+9lUJCXYdi6Zh7Du3cfGN68e89Q29xLNQcwDkQhhAwGvi4gtQ1HTfDo+lHGgQ+BQeGAgYgGmJ1M6AL0tBzFAQMFUBxAj1BAtwMjBGjpCGxmY40CWjgCl5kELaK0qCbkGYKJkJLQIEYvyYZTu3sOAH6uloRBx5zYAAAAAElFTkSuQmCC";
        const fallbackPath = path.join(DATA_DIR, "tray-icon.png");
        try {
            fs.writeFileSync(fallbackPath, Buffer.from(base64, "base64"));
            return nativeImage.createFromPath(fallbackPath);
        }
        catch {
            return nativeImage.createEmpty();
        }
    }
    function startBackend() {
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
        backendProc.stdout?.on("data", (d) => process.stdout.write(`[backend] ${d}`));
        backendProc.stderr?.on("data", (d) => process.stderr.write(`[backend] ${d}`));
        // Poll port until the server is ready (up to 20 seconds)
        return new Promise((resolve) => {
            let resolved = false;
            const done = () => {
                if (!resolved) {
                    resolved = true;
                    resolve();
                }
            };
            backendProc.once("message", done);
            const deadline = Date.now() + 20_000;
            const poll = () => {
                if (resolved)
                    return;
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
        const iconPath = path.resolve(appRoot, "caretaker.png");
        let appIcon;
        try {
            if (fs.existsSync(iconPath)) {
                appIcon = nativeImage.createFromPath(iconPath);
            }
        }
        catch {
            appIcon = undefined;
        }
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
                mainWindow.hide();
            }
            else {
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
                }
                else {
                    mainWindow.show();
                    mainWindow.focus();
                }
            }
        });
    }
    function updateTrayMenu() {
        if (!tray)
            return;
        const visible = mainWindow?.isVisible() ?? false;
        const menu = Menu.buildFromTemplate([
            {
                label: visible ? "Hide" : "Show",
                click: () => {
                    if (mainWindow) {
                        if (mainWindow.isVisible()) {
                            mainWindow.hide();
                        }
                        else {
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
    app.on("second-instance", () => {
        if (mainWindow) {
            if (mainWindow.isMinimized())
                mainWindow.restore();
            if (!mainWindow.isVisible())
                mainWindow.show();
            mainWindow.focus();
        }
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
    app.on("before-quit", () => {
        isQuitting = true;
        backendProc?.kill();
        try {
            fs.unlinkSync(PORT_FILE);
        }
        catch {
            // ignore
        }
    });
}
