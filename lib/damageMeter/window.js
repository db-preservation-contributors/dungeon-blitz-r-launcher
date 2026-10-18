'use strict';

const path = require('path');
const { BrowserWindow, clipboard, dialog, ipcMain, screen, shell } = require('electron');

/**
 * The damage meter's own window: the Damage Meter, Rotation and Spells panels (renderer/
 * damage-meter), for the player to keep beside the game. The game runs in FlashBrowser or the
 * standalone Flash Player, other programs, so the meter can't sit inside its window the way the
 * DB DPS Launcher's does.
 *
 * Locked down like the launcher window: context isolation, a sandboxed preload with a fixed set
 * of calls, no Node, no plugins, no webviews, and no developer tools in an installed launcher.
 * The page loads only its own files; navigation and new windows are refused by main.js's
 * web-contents-created handler like every other page's.
 */

const DEFAULT_SIZE = { width: 620, height: 760 };
const MIN_SIZE = { width: 420, height: 420 };

class DamageMeterWindow {
    /**
     * @param {object} options
     * @param {import('./index').DamageMeter} options.meter
     * @param {string} options.rootDir the launcher's root (renderer/ is under it)
     * @param {string} [options.icon]
     * @param {boolean} [options.isPackaged]
     */
    constructor({ meter, rootDir, icon, isPackaged }) {
        this.meter = meter;
        this.rootDir = rootDir;
        this.icon = icon;
        this.isPackaged = Boolean(isPackaged);
        this.window = null;
        this.saveTimer = null;

        this.meter.io = {
            documentsDir: safeDocumentsDir(),
            saveDialog: async (defaultPath, filters) => {
                const result = await dialog.showSaveDialog(this.window && !this.window.isDestroyed() ? this.window : undefined, {
                    title: 'Export DPS results',
                    defaultPath,
                    filters
                });
                return result.canceled ? '' : result.filePath || '';
            },
            writeClipboard: (text) => clipboard.writeText(String(text || '')),
            showItemInFolder: (file) => shell.showItemInFolder(file),
            showError: (message) => {
                const options = { type: 'error', title: 'Damage Meter', message: String(message || '') };
                void (this.isOpen() ? dialog.showMessageBox(this.window, options) : dialog.showMessageBox(options));
            }
        };
        this.meter.on('view', (view) => this.send(view));
        this.meter.on('pin', (pinned) => {
            if (this.isOpen()) this.window.setAlwaysOnTop(Boolean(pinned));
        });

        ipcMain.handle('damageMeter:command', (event, cmd, arg) => {
            // Only the meter's own page may drive the meter.
            if (!this.isOpen() || event.sender !== this.window.webContents) return { ok: false, error: 'not the meter window' };
            return this.meter.command(String(cmd || ''), arg);
        });
    }

    isOpen() {
        return Boolean(this.window && !this.window.isDestroyed());
    }

    /** Opens the window, or brings it forward when it is already open. */
    open() {
        if (this.isOpen()) {
            if (this.window.isMinimized()) this.window.restore();
            this.window.show();
            this.window.focus();
            return;
        }
        const bounds = fitBounds(this.meter.settings.bounds);
        const win = new BrowserWindow({
            ...bounds,
            minWidth: MIN_SIZE.width,
            minHeight: MIN_SIZE.height,
            title: 'Damage Meter',
            backgroundColor: '#1d1e26',
            show: false,
            icon: this.icon,
            alwaysOnTop: Boolean(this.meter.settings.pinned),
            autoHideMenuBar: true,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                plugins: false,
                devTools: !this.isPackaged,
                webviewTag: false
            }
        });
        win.setMenuBarVisibility(false);
        win.loadFile(path.join(this.rootDir, 'renderer', 'damage-meter', 'index.html'));
        win.once('ready-to-show', () => win.show());
        win.on('move', () => this.rememberBounds());
        win.on('resize', () => this.rememberBounds());
        win.on('closed', () => {
            this.window = null;
            this.meter.watch(false);
        });
        this.window = win;
        this.meter.watch(true);
    }

    close() {
        if (this.isOpen()) this.window.close();
    }

    send(view) {
        if (this.isOpen()) this.window.webContents.send('damageMeter:view', view);
    }

    rememberBounds() {
        if (!this.isOpen() || this.window.isMinimized() || this.window.isMaximized()) return;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            if (!this.isOpen()) return;
            this.meter.settings.bounds = this.window.getBounds();
            this.meter.saveSettings();
        }, 500);
    }
}

/**
 * The saved place, if it is still on a screen; else the default size, centred, made smaller to
 * fit a short screen (a 1366x768 laptop has less room than 760 px under its taskbar). The
 * panels' text shrinks to fit the window's height (renderer/damage-meter/meter.js).
 */
function fitBounds(saved) {
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && saved.width > 0 && saved.height > 0) {
        const visible = screen.getAllDisplays().some((d) => {
            const a = d.workArea;
            return saved.x < a.x + a.width - 40 && saved.x + saved.width > a.x + 40 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 40;
        });
        if (visible) return { x: saved.x, y: saved.y, width: Math.max(MIN_SIZE.width, saved.width), height: Math.max(MIN_SIZE.height, saved.height) };
    }
    const area = screen.getPrimaryDisplay().workAreaSize;
    return {
        width: Math.max(MIN_SIZE.width, Math.min(DEFAULT_SIZE.width, area.width)),
        height: Math.max(MIN_SIZE.height, Math.min(DEFAULT_SIZE.height, area.height))
    };
}

function safeDocumentsDir() {
    try {
        return require('electron').app.getPath('documents');
    } catch {
        return '';
    }
}

module.exports = { DamageMeterWindow };
