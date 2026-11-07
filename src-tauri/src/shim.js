(function () {
    if (window.launcher) {
        return;
    }
    const core = () => window.__TAURI__.core;
    const call = (command, args) => core().invoke(command, args || {});
    window.launcher = Object.freeze({
        getState: () => call('get_state'),
        discordLogin: () => call('discord_login'),
        copySignInLink: () => call('copy_sign_in_link'),
        submitLoginCode: (code) => call('submit_login_code', { code: String(code || '') }),
        forgetDiscordLogin: () => call('forget_discord_login'),
        play: (engine) => call('play', { engine: engine === 'projector' ? 'projector' : '' }),
        browseFlash: () => call('browse_flash'),
        moveToApplications: () => call('move_to_applications'),
        relaunch: () => call('relaunch'),
        quit: () => call('quit'),
        updateInstall: () => call('update_install'),
        updateDownload: () => call('update_download'),
        gameStatsSync: () => call('game_stats_sync'),
        setGraphics: (settings) => call('set_graphics', { settings: settings || {} }),
        setDevMode: (on) => call('set_dev_mode', { on: on === true }),
        devChooseServer: () => call('dev_choose_server'),
        devCreate: () => call('dev_create'),
        devStop: () => call('dev_stop'),
        devCopyShare: () => call('dev_copy_share'),
        devPlayOwn: () => call('dev_play_own'),
        devJoin: (address) => call('dev_join', { address: String(address || '') }),
        onState: (handler) => {
            let unlisten = null;
            let stopped = false;
            window.__TAURI__.event.listen('launcher:state', (event) => handler(event.payload)).then((fn) => {
                if (stopped) {
                    fn();
                } else {
                    unlisten = fn;
                }
            });
            return () => {
                stopped = true;
                if (unlisten) {
                    unlisten();
                }
            };
        }
    });
})();
