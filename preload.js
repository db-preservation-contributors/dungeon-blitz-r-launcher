'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The launcher shell runs with contextIsolation on and no Node access; everything it can
// do is the fixed set of calls below, each answered by the main process.
contextBridge.exposeInMainWorld('launcher', {
    getState: () => ipcRenderer.invoke('launcher:getState'),
    discordLogin: () => ipcRenderer.invoke('launcher:discordLogin'),
    copySignInLink: () => ipcRenderer.invoke('launcher:copySignInLink'),
    submitLoginCode: (code) => ipcRenderer.invoke('launcher:submitLoginCode', code),
    forgetDiscordLogin: () => ipcRenderer.invoke('launcher:forgetDiscordLogin'),
    // The game in the build's own engine.
    play: () => ipcRenderer.invoke('launcher:play'),
    browseFlash: () => ipcRenderer.invoke('launcher:browseFlash'),
    moveToApplications: () => ipcRenderer.invoke('launcher:moveToApplications'),
    relaunch: () => ipcRenderer.invoke('launcher:relaunch'),
    quit: () => ipcRenderer.invoke('launcher:quit'),
    updateInstall: () => ipcRenderer.invoke('launcher:updateInstall'),
    // Opens the update the main process found; it takes no URL from this side.
    updateDownload: () => ipcRenderer.invoke('launcher:updateDownload'),
    gameStatsSync: () => ipcRenderer.invoke('launcher:gameStatsSync'),
    damageMeterOpen: () => ipcRenderer.invoke('launcher:damageMeterOpen'),
    setGraphics: (settings) => ipcRenderer.invoke('launcher:setGraphics', settings),
    onState: (handler) => {
        const listener = (_event, state) => handler(state);
        ipcRenderer.on('launcher:state', listener);
        return () => ipcRenderer.removeListener('launcher:state', listener);
    }
});
