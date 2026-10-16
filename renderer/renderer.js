'use strict';

const elements = {
    discordLogin: document.getElementById('discord-login'),
    copyLogin: document.getElementById('copy-login'),
    loginCode: document.getElementById('login-code'),
    loginCodeInput: document.getElementById('login-code-input'),
    loginCodeSubmit: document.getElementById('login-code-submit'),
    loginCodeError: document.getElementById('login-code-error'),
    play: document.getElementById('play'),
    altEngine: document.getElementById('alt-engine'),
    playProjector: document.getElementById('play-projector'),
    playFlashBrowser: document.getElementById('play-flashbrowser'),
    status: document.getElementById('status'),
    problem: document.getElementById('problem'),
    repair: document.getElementById('repair'),
    browseFlash: document.getElementById('browse-flash'),
    relaunch: document.getElementById('relaunch'),
    moveApp: document.getElementById('move-app'),
    account: document.getElementById('account'),
    accountName: document.getElementById('account-name'),
    forget: document.getElementById('forget'),
    versions: document.getElementById('versions'),
    updateInstall: document.getElementById('update-install'),
    gameStatsSync: document.getElementById('game-stats-sync'),
    damageMeterOpen: document.getElementById('damage-meter-open'),
    tools: document.getElementById('tools'),
    quit: document.getElementById('quit'),
    engineStatus: document.getElementById('engine-status')
};

/**
 * The rows under the problem banner, kept to what a player cares about: whether Discord
 * shows them as playing, whether their lobby chat is connected, whether their widget
 * profile was written, and which version they run. The values stay short and the detail
 * (last status, last error) moves into the tooltip.
 *
 * Machine and engine details -- the Windows build, the Flash Player path, the chat mirror's
 * counters -- are not rows: a fault there is said in the problem banner above instead, which
 * is where it can be acted on.
 */
function engineRows(state) {
    const social = state.social || {};
    const presence = state.presence || {};
    const widget = state.gameStats || {};

    // "Starts with the game" is the normal state on the sign-in screen: the bridge is
    // deliberately idle until a game session asks for it.
    let socialValue = 'starts with the game';
    let socialTone = 'muted';
    let socialDetail = social.lastStatus || '';
    if (!social.enabled) {
        socialValue = 'off';
    } else if (social.lobbyReady) {
        socialValue = 'connected';
        socialTone = 'ok';
    } else if (social.authPending) {
        socialValue = 'waiting for Discord approval';
        socialTone = 'warn';
    } else if (/Discord desktop client is not running/i.test(social.lastStatus || '')) {
        // The one "lobby never connects" cause a player can fix themselves; say it instead
        // of leaving a generic "connecting..." to decode.
        socialValue = 'Discord client not running';
        socialTone = 'bad';
    } else if (social.running) {
        socialValue = 'connecting...';
        socialTone = 'warn';
    }

    // Discord's own window is the only place rich presence can be seen, so this row is
    // what tells the difference between "Discord has it" and "nothing was ever sent".
    let presenceValue = 'starts with the game';
    let presenceTone = 'muted';
    let presenceDetail = 'Rich presence is served by the launcher while the game runs.';
    if (presence.ready) {
        presenceValue = presence.activity || (presence.characterName ? `playing ${presence.characterName}` : 'connected');
        presenceTone = 'ok';
        presenceDetail = ['Discord client reached', presence.port ? `local endpoint 127.0.0.1:${presence.port}` : '']
            .filter(Boolean)
            .join(' - ');
    } else if (presence.running) {
        presenceValue = 'waiting for Discord';
        presenceTone = 'warn';
        presenceDetail = presence.lastError || 'The Discord desktop client is not reachable.';
    } else if (presence.lastError) {
        presenceValue = 'unavailable';
        presenceTone = 'bad';
        presenceDetail = presence.lastError;
    }

    // The version row: the version this launcher is, and what the updater is doing about the
    // next one. Quiet unless there is something a player can act on: a downloaded update is
    // 'ok' (the restart button appears below), a check failure stays 'muted' -- offline
    // moments and unsigned-macOS limits are not launcher faults.
    const update = state.update || {};
    const current = `v${state.appVersion || update.currentVersion || ''}`;
    let updateValue = `${current} - up to date`;
    let updateTone = 'muted';
    let updateDetail = 'The launcher checks GitHub for a newer version after start and every six hours.';
    if (update.state === 'disabled') {
        updateValue = current;
        updateDetail = 'Updates are checked only in an installed launcher.';
    } else if (update.state === 'downloading') {
        updateValue = update.percent
            ? `${current} - downloading ${update.version} (${update.percent}%)`
            : `${current} - downloading ${update.version}`;
        updateTone = 'warn';
    } else if (update.state === 'downloaded') {
        updateValue = `${current} - ${update.version} ready, restart to install`;
        updateTone = 'ok';
    } else if (update.state === 'checking') {
        updateValue = `${current} - checking...`;
    }

    // The Discord widget is filled by the game server, which holds the bot token; the
    // launcher only asks. So this row is where "the widget is empty" stops being a guess:
    // it says whether a profile was written, and when it was not, which half is missing.
    let widgetValue = 'starts with the game';
    let widgetTone = 'muted';
    let widgetDetail = 'The server writes your Discord widget profile when you play.';
    if (widget.enabled === false) {
        widgetValue = 'off';
        widgetDetail = 'Disabled with DUNGEON_BLITZ_GAME_STATS=0.';
    } else if (widget.state === 'syncing') {
        widgetValue = 'writing...';
    } else if (widget.state === 'written') {
        const writtenAt = widget.updatedAt ? new Date(widget.updatedAt).toLocaleTimeString() : '';
        widgetValue = 'profile written';
        widgetTone = 'ok';
        widgetDetail = [
            `Discord has a widget profile${widget.username ? ` for ${widget.username}` : ''}.`,
            writtenAt ? `Last written at ${writtenAt}.` : ''
        ]
            .filter(Boolean)
            .join(' ');
    } else if (widget.state === 'unlinked') {
        widgetValue = 'no Discord account linked';
        widgetTone = 'warn';
        widgetDetail = widget.lastError;
    } else if (widget.state === 'unsupported') {
        widgetValue = 'server cannot write it';
        widgetTone = 'warn';
        widgetDetail = widget.lastError;
    } else if (widget.state === 'error') {
        widgetValue = 'failed';
        widgetTone = 'warn';
        widgetDetail = widget.lastError;
    }

    return [
        { label: 'Discord status', value: presenceValue, tone: presenceTone, detail: presenceDetail },
        { label: 'Lobby chat', value: socialValue, tone: socialTone, detail: socialDetail },
        { label: 'Game stats', value: widgetValue, tone: widgetTone, detail: widgetDetail },
        { label: 'Version', value: updateValue, tone: updateTone, detail: updateDetail }
    ];
}

function renderEngineStatus(state) {
    const rows = engineRows(state).map((row) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'engine-row';

        const label = document.createElement('dt');
        label.textContent = row.label;

        const value = document.createElement('dd');
        value.className = row.tone;
        value.textContent = row.value;
        if (row.detail) {
            value.title = row.detail;
        }

        wrapper.append(label, value);
        return wrapper;
    });

    elements.engineStatus.replaceChildren(...rows);
}

let currentState = null;

const COPY_LOGIN_LABEL = "Browser didn't open? Copy the sign-in link";

function showProblem(message, severity) {
    elements.problem.hidden = !message;
    elements.problem.textContent = message || '';
    elements.problem.className = severity === 'bad' ? 'problem bad' : 'problem';
    elements.repair.hidden = !message;
    // An installed launcher runs only its own, verified Flash Player: nothing to choose.
    elements.browseFlash.hidden = Boolean(currentState && currentState.flash && currentState.flash.locked);
}

/**
 * A copy running from a mounted disk image or from Downloads is a copy the next build will
 * not replace -- the quiet way players end up on a launcher that no longer works. The
 * banner stays until the app has been moved.
 */
function installWarning(state) {
    const install = state.install || {};
    if (!install.relocate) {
        return null;
    }

    return {
        message: install.canMove
            ? `${install.message} Move it to ${install.targetPath}.`
            : install.message,
        severity: 'warn'
    };
}

/**
 * The play buttons. The main one is Ruffle, the default: the game page with the Ruffle Flash
 * emulator, drawn on the GPU, in the launcher's own window -- it needs nothing installed, so
 * it plays wherever there is a server. Legacy (Adobe Flash Player 32) is always offered next,
 * and FlashBrowser where there is one (not on 32-bit Windows or Linux).
 */
function playButtons(state) {
    const flash = state.flash || {};
    const browser = state.flashBrowser || {};
    const hasServers = Array.isArray(state.servers) && state.servers.length > 0;
    return {
        mainEngine: 'ruffle',
        mainPlayable: hasServers,
        projectorPlayable: Boolean(flash.armed && !flash.archMismatch && hasServers),
        flashBrowserOffered: Boolean(browser.offered),
        flashBrowserPlayable: Boolean(browser.offered && browser.ready && hasServers)
    };
}

function applyPlayButtons(state) {
    const buttons = playButtons(state);
    elements.play.disabled = !buttons.mainPlayable;
    elements.altEngine.hidden = false;
    elements.playProjector.disabled = !buttons.projectorPlayable;
    elements.playFlashBrowser.hidden = !buttons.flashBrowserOffered;
    elements.playFlashBrowser.disabled = !buttons.flashBrowserPlayable;
    return buttons;
}

/** What is wrong with Flash Player, which the Legacy button runs, when it cannot run. */
function flashPlayerProblem(state) {
    const flash = state.flash || {};
    if (!flash.found) {
        return {
            message: flash.locked
                ? 'Flash Player is missing from this install. Reinstall the launcher to play Legacy; the main button still plays.'
                : 'Flash Player is missing. Point the launcher at it to play Legacy; the main button still plays.',
            severity: 'warn'
        };
    }
    if (flash.tampered) {
        return {
            message:
                'The Flash Player files were changed after installation, so Legacy will not start. ' +
                'Reinstall the launcher to use it; the main button still plays.',
            severity: 'bad'
        };
    }
    if (flash.archMismatch) {
        return {
            message:
                `This Flash Player is a ${(flash.architectures || []).join('/')} program and cannot run on this machine. ` +
                'Choose the flashplayer_32_sa build for this system to play Legacy; the main button still plays.',
            severity: 'warn'
        };
    }
    return null;
}

/** What is wrong with FlashBrowser, when this system has one and it cannot run. */
function flashBrowserProblem(state) {
    const browser = state.flashBrowser || {};
    if (!browser.offered) {
        return null;
    }
    if (browser.tampered) {
        return {
            message:
                'The FlashBrowser files were changed after installation, so it will not start. ' +
                'Reinstall the launcher to use it; the main button still plays.',
            severity: 'bad'
        };
    }
    if (!browser.found) {
        return {
            message: browser.locked
                ? 'FlashBrowser is missing from this install. Reinstall the launcher to use it; the main button still plays.'
                : 'FlashBrowser is missing. Run `npm run fetch-flash-browser` to use it; the main button still plays.',
            severity: 'warn'
        };
    }
    return null;
}

// One line, because the launcher is a sign-in screen: whatever is currently keeping the
// player out of the game, or how far the sign-in has got.
function statusLine(state) {
    if (state.gameRunning) {
        const names = { ruffle: 'Ruffle', projector: 'Legacy', flashbrowser: 'FlashBrowser' };
        return `The game is running (${names[state.gameEngine] || 'Ruffle'}).`;
    }
    if (state.discord.loginPending && state.discord.loginCodeRequired) {
        return 'Enter the code from your browser.';
    }
    if (state.discord.loginPending) {
        return 'Finish signing in in your browser...';
    }
    if (state.discord.linked) {
        return state.discord.remembered ? 'Ready to play.' : `${accountLabel(state.discord)}.`;
    }
    if (state.serverReachable === false) {
        return 'The server is not responding.';
    }
    if (state.serverReachable === null) {
        return 'Checking the server...';
    }
    return 'Sign in with Discord to play.';
}

function accountLabel(discord) {
    const name = String((discord && discord.name) || '').trim();
    if (name) {
        return `Signed in as ${name}`;
    }
    const email = String((discord && discord.email) || '').trim();
    return email ? `Signed in as ${email}` : 'Signed in';
}

function render(state) {
    currentState = state;

    elements.status.textContent = statusLine(state);
    // A known account replaces the button outright: asking a player who is already signed
    // in to sign in again is the thing this row exists to stop.
    elements.discordLogin.hidden = state.discord.remembered;
    elements.discordLogin.disabled = state.discord.loginPending || !state.serverReachable;
    elements.discordLogin.querySelector('.label').textContent = state.discord.loginPending
        ? 'Waiting for your browser...'
        : 'Sign in with Discord';
    // Reset to its own label whenever the sign-in it belongs to is not the one on screen.
    const showCopy = Boolean(state.discord.loginPending && state.discord.loginLinkAvailable);
    if (!showCopy) {
        elements.copyLogin.textContent = COPY_LOGIN_LABEL;
    }
    elements.copyLogin.hidden = !showCopy;
    const askCode = Boolean(state.discord.loginPending && state.discord.loginCodeRequired);
    if (!askCode) {
        elements.loginCodeInput.value = '';
    }
    elements.loginCode.hidden = !askCode;
    elements.loginCodeError.hidden = !(askCode && state.discord.loginCodeRejected);
    elements.account.hidden = !state.discord.remembered;
    elements.accountName.textContent = accountLabel(state.discord);
    applyPlayButtons(state);
    // Flash Player is started fresh for every game, so a new choice never needs a restart.
    elements.relaunch.hidden = true;
    elements.forget.hidden = !state.discord.remembered;

    // What keeps the main button (Ruffle) from playing comes first; a fault in Legacy or
    // FlashBrowser only takes away its own button, so it is said last.
    const problem =
        (state.discord && state.discord.loginCodeEnded
            ? { message: 'Too many wrong codes, so that sign-in was cancelled. Sign in with Discord again.', severity: 'bad' }
            : null) ||
        (state.notice ? { message: state.notice, severity: 'warn' } : null) ||
        (state.serverReachable === false ? { message: `Could not reach ${state.selectedServerUrl}`, severity: 'bad' } : null) ||
        installWarning(state) ||
        flashPlayerProblem(state) ||
        flashBrowserProblem(state);
    showProblem(problem ? problem.message : '', problem ? problem.severity : '');

    elements.moveApp.hidden = !(state.install && state.install.relocate && state.install.canMove);

    // The restart-to-update button appears only when a full update is sitting downloaded;
    // every other state leaves the strip to say what is happening instead.
    elements.updateInstall.hidden = !state.update || state.update.state !== 'downloaded';
    // Syncing only means something once a session has given the launcher a server to ask, so
    // the button stays off the sign-in screen where there is nothing to write yet.
    elements.gameStatsSync.hidden = !state.gameStats || !state.gameStats.running || state.gameStats.enabled === false;
    // The damage meter reads a game session's hits and keeps the last fight after it, so it is
    // offered once there is an account to play with, or while its window is open anyway.
    const meter = state.damageMeter || {};
    elements.damageMeterOpen.hidden =
        meter.enabled === false || !(state.discord.remembered || state.gameRunning || meter.open);
    elements.tools.hidden = elements.damageMeterOpen.hidden && elements.gameStatsSync.hidden;

    renderEngineStatus(state);
    elements.versions.textContent = `v${state.appVersion}`;
}

elements.copyLogin.addEventListener('click', async () => {
    const result = await window.launcher.copySignInLink();
    elements.copyLogin.textContent =
        result && result.ok ? 'Link copied. Paste it into your browser.' : 'The sign-in has ended. Sign in again.';
});

async function submitLoginCode() {
    const code = String(elements.loginCodeInput.value || '').trim();
    if (!code) {
        return;
    }
    await window.launcher.submitLoginCode(code);
}

elements.loginCodeSubmit.addEventListener('click', () => {
    void submitLoginCode();
});

elements.loginCodeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        void submitLoginCode();
    }
});

elements.discordLogin.addEventListener('click', async () => {
    const result = await window.launcher.discordLogin();
    if (result && !result.ok) {
        showProblem(result.message || 'Could not start the Discord sign-in.', 'bad');
    }
});

async function playWith(engine) {
    elements.play.disabled = true;
    elements.playProjector.disabled = true;
    elements.playFlashBrowser.disabled = true;
    const result = await window.launcher.play(engine);
    if (!result || !result.ok) {
        showProblem((result && result.message) || 'Could not start the game.', 'bad');
    }
    if (currentState) {
        applyPlayButtons(currentState);
    }
}

elements.play.addEventListener('click', () => {
    void playWith(currentState ? playButtons(currentState).mainEngine : '');
});

elements.playProjector.addEventListener('click', () => {
    void playWith('projector');
});

elements.playFlashBrowser.addEventListener('click', () => {
    void playWith('flashbrowser');
});

elements.forget.addEventListener('click', async () => {
    render(await window.launcher.forgetDiscordLogin());
});

elements.browseFlash.addEventListener('click', async () => {
    render(await window.launcher.browseFlash());
});

elements.relaunch.addEventListener('click', () => {
    void window.launcher.relaunch();
});

elements.updateInstall.addEventListener('click', () => {
    void window.launcher.updateInstall();
});

elements.gameStatsSync.addEventListener('click', async () => {
    const button = elements.gameStatsSync;
    button.disabled = true;
    try {
        const summary = await window.launcher.gameStatsSync();
        if (summary) {
            render({ ...currentState, gameStats: summary });
        }
    } finally {
        button.disabled = false;
    }
});

elements.damageMeterOpen.addEventListener('click', () => {
    void window.launcher.damageMeterOpen();
});

elements.moveApp.addEventListener('click', async () => {
    const result = await window.launcher.moveToApplications();
    if (result && !result.ok) {
        showProblem(result.message || 'Could not move the launcher.', 'bad');
    }
});

elements.quit.addEventListener('click', () => {
    void window.launcher.quit();
});

window.launcher.onState(render);
window.launcher.getState().then(render);
