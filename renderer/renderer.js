'use strict';

const elements = {
    discordLogin: document.getElementById('discord-login'),
    copyLogin: document.getElementById('copy-login'),
    loginCode: document.getElementById('login-code'),
    loginCodeInput: document.getElementById('login-code-input'),
    loginCodeSubmit: document.getElementById('login-code-submit'),
    loginCodeError: document.getElementById('login-code-error'),
    play: document.getElementById('play'),
    playLegacy: document.getElementById('play-legacy'),
    accountReveal: document.getElementById('account-reveal'),
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
    updateActions: document.getElementById('update-actions'),
    updateInstall: document.getElementById('update-install'),
    updateDownload: document.getElementById('update-download'),
    gameStatsSync: document.getElementById('game-stats-sync'),
    damageMeterOpen: document.getElementById('damage-meter-open'),
    tools: document.getElementById('tools'),
    quit: document.getElementById('quit'),
    engineStatus: document.getElementById('engine-status'),
    graphicsRenderer: document.getElementById('graphics-renderer'),
    graphicsQuality: document.getElementById('graphics-quality'),
    graphicsNote: document.getElementById('graphics-note'),
    devMode: document.getElementById('dev-mode'),
    developer: document.getElementById('developer'),
    devRoot: document.getElementById('dev-root'),
    devChoose: document.getElementById('dev-choose'),
    devCreate: document.getElementById('dev-create'),
    devStop: document.getElementById('dev-stop'),
    devServerStatus: document.getElementById('dev-server-status'),
    devShare: document.getElementById('dev-share'),
    devShareUrl: document.getElementById('dev-share-url'),
    devCopy: document.getElementById('dev-copy'),
    devPlayOwn: document.getElementById('dev-play-own'),
    devJoinAddress: document.getElementById('dev-join-address'),
    devJoin: document.getElementById('dev-join'),
    devJoinStatus: document.getElementById('dev-join-status')
};

const LABELS = { gpu: 'GPU', cpu: 'CPU', high: 'High', medium: 'Medium', low: 'Low' };

function renderGraphics(graphics) {
    if (!graphics) {
        return;
    }
    elements.graphicsRenderer.value = graphics.renderer;
    elements.graphicsQuality.value = graphics.quality;
    elements.graphicsRenderer.options[0].textContent = `Auto (${LABELS[graphics.resolvedRenderer]})`;
    elements.graphicsQuality.options[0].textContent = `Auto (${LABELS[graphics.resolvedQuality]})`;
    const restart = graphics.renderer === 'cpu' && graphics.launcherOnGpu;
    elements.graphicsNote.textContent = restart
        ? 'Applies to the next game. The launcher window switches to CPU after a restart.'
        : 'Applies to the next game.';
    document.body.classList.toggle('low-graphics', graphics.resolvedQuality === 'low');
}

async function saveGraphics() {
    const next = await window.launcher.setGraphics({
        renderer: elements.graphicsRenderer.value,
        quality: elements.graphicsQuality.value
    });
    if (next) {
        render(next);
    }
}

elements.graphicsRenderer.addEventListener('change', () => {
    void saveGraphics();
});
elements.graphicsQuality.addEventListener('change', () => {
    void saveGraphics();
});

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
    } else if (update.state === 'available') {
        // A build that cannot install updates itself (macOS, portable, 32-bit setup): the
        // Download button below opens the new release's file in the browser.
        updateValue = `${current} - launcher ${update.version} is available`;
        updateTone = 'ok';
        updateDetail = `Download opens ${update.asset || 'the release page'} on GitHub; install it over this copy.`;
    } else if (update.state === 'checking') {
        updateValue = `${current} - checking...`;
    }
    if (update.mode === 'notice' && update.state !== 'available') {
        updateDetail =
            'The launcher checks GitHub for a newer version after start and every six hours. This build cannot install it itself, so a download link appears here.';
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
    // A Flash Player is only ever chosen by hand in a checkout whose engine is Flash Player: an
    // installed launcher runs only its own, verified one, and an AIR build runs none at all.
    elements.browseFlash.hidden = Boolean(
        currentState && ((currentState.flash && currentState.flash.locked) || engineOf(currentState) === 'air')
    );
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
 * The build's engine, as main.js names it: AIR wherever the build carries it, and the standalone
 * Flash Player only in the builds AIR has no runtime for. Never the player's pick.
 */
function engineOf(state) {
    return state && state.engine === 'projector' ? 'projector' : 'air';
}

/** The one play button: it needs the build's engine able to run here, and a server to play on. */
function playButtons(state) {
    const hasServers = Array.isArray(state.servers) && state.servers.length > 0;
    const engine = engineOf(state);
    const flash = state.flash || {};
    const air = state.air || {};
    const ready = engine === 'air' ? Boolean(air.ready) : Boolean(flash.armed && !flash.archMismatch);
    const legacyReady = Boolean(flash.armed && !flash.archMismatch);
    return {
        engine,
        playable: ready && hasServers,
        legacyOffered: engine === 'air' && Boolean(flash.found),
        legacyPlayable: legacyReady && hasServers
    };
}

function applyPlayButtons(state) {
    const buttons = playButtons(state);
    elements.play.disabled = !buttons.playable;
    elements.playLegacy.hidden = !buttons.legacyOffered;
    elements.playLegacy.disabled = !buttons.legacyPlayable;
    return buttons;
}

/** What keeps the build's engine from starting the game, or null. */
function engineProblem(state) {
    return engineOf(state) === 'air' ? airProblem(state) : flashPlayerProblem(state);
}

/** What is wrong with Flash Player, the engine of a build with no AIR, when it cannot run. */
function flashPlayerProblem(state) {
    const flash = state.flash || {};
    if (!flash.found) {
        return {
            message: flash.locked
                ? 'Flash Player is missing from this install. Reinstall the launcher to play.'
                : 'Flash Player is missing. Point the launcher at it to play.',
            severity: 'bad'
        };
    }
    if (flash.tampered) {
        return {
            message:
                'The Flash Player files were changed after installation, so the game will not start. ' +
                'Reinstall the launcher to play.',
            severity: 'bad'
        };
    }
    if (flash.archMismatch) {
        return {
            message:
                `This Flash Player is a ${(flash.architectures || []).join('/')} program and cannot run on this machine. ` +
                'Choose the flashplayer_32_sa build for this system.',
            severity: 'bad'
        };
    }
    return null;
}

/** What is wrong with the AIR engine, the engine of this build, when it cannot run. */
function airProblem(state) {
    const air = state.air || {};
    if (!air.found) {
        return {
            message:
                state.flash && state.flash.locked
                    ? 'The AIR engine is missing from this install. Reinstall the launcher to play.'
                    : 'The AIR engine is missing. Run `npm run build-air` with AIR_SDK_HOME set.',
            severity: 'bad'
        };
    }
    if (air.tampered) {
        return {
            message:
                'The AIR engine files were changed after installation, so the game will not start. ' +
                'Reinstall the launcher to play.',
            severity: 'bad'
        };
    }
    return null;
}

// One line, because the launcher is a sign-in screen: whatever is currently keeping the
// player out of the game, or how far the sign-in has got.
function statusLine(state) {
    if (state.gameRunning) {
        return 'The game is running.';
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

let emailRevealed = false;

function maskEmail(email) {
    const at = email.indexOf('@');
    if (at < 1) {
        return '•••••';
    }
    return `${email.slice(0, Math.min(2, at))}•••••${email.slice(at)}`;
}

function accountEmail(discord) {
    const name = String((discord && discord.name) || '').trim();
    return name ? '' : String((discord && discord.email) || '').trim();
}

function accountLabel(discord, reveal = false) {
    const name = String((discord && discord.name) || '').trim();
    if (name) {
        return `Signed in as ${name}`;
    }
    const email = accountEmail(discord);
    return email ? `Signed in as ${reveal ? email : maskEmail(email)}` : 'Signed in';
}

/**
 * Developer mode: the switch in Settings, and the panel it shows. Create is a test server from a
 * game server checkout behind two tunnels; Join plays one by its shared address. Both play in
 * AIR, so a build without it says so instead.
 */
function renderDev(state) {
    const dev = state.dev || {};
    const server = dev.server || {};
    elements.devMode.checked = Boolean(dev.enabled);
    elements.developer.hidden = !dev.enabled;
    if (!dev.enabled) {
        return;
    }

    const busy = server.state === 'starting' || server.state === 'running';
    elements.devRoot.textContent = dev.serverRoot ? `Folder: ${dev.serverRoot}` : 'No game server folder chosen yet.';
    elements.devChoose.disabled = busy;
    elements.devCreate.hidden = busy;
    elements.devCreate.disabled = !dev.serverRoot;
    elements.devStop.hidden = !busy;

    let status = '';
    if (server.state === 'starting') {
        status = server.step || 'Starting...';
    } else if (server.state === 'running') {
        status = 'Running. Share this address:';
    } else if (server.state === 'error') {
        status = server.error;
    }
    elements.devServerStatus.textContent = status;
    elements.devServerStatus.className = server.state === 'error' ? 'developer__status bad' : 'developer__status';
    if (server.state === 'error' && Array.isArray(server.logTail) && server.logTail.length) {
        elements.devServerStatus.title = server.logTail.join('\n');
    } else {
        elements.devServerStatus.title = '';
    }

    const running = server.state === 'running';
    elements.devShare.hidden = !running;
    elements.devShareUrl.value = running ? server.shareUrl : '';
    elements.devPlayOwn.hidden = !running;
    elements.devPlayOwn.disabled = Boolean(state.gameRunning);

    const join = dev.join || {};
    elements.devJoin.disabled = join.state === 'joining' || Boolean(state.gameRunning);
    elements.devJoinStatus.textContent =
        join.state === 'joining' ? 'Joining...' : join.state === 'playing' ? 'Playing on that server.' : join.error || '';
    elements.devJoinStatus.className = join.error ? 'developer__status bad' : 'developer__status';
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
    elements.accountName.textContent = accountLabel(state.discord, emailRevealed);
    elements.accountReveal.hidden = !accountEmail(state.discord);
    elements.accountReveal.className = emailRevealed ? 'account-reveal on' : 'account-reveal';
    elements.accountReveal.title = emailRevealed ? 'Hide email' : 'Show email';
    applyPlayButtons(state);
    // Flash Player is started fresh for every game, so a new choice never needs a restart.
    elements.relaunch.hidden = true;
    elements.forget.hidden = !state.discord.remembered;

    // Whatever keeps the play button from starting the game comes first: a cancelled sign-in,
    // the answer to the player's own pick of a Flash Player, an engine that cannot run, an
    // unreachable server. A launcher run from a disk image still plays, so it is said last.
    const problem =
        (state.discord && state.discord.loginCodeEnded
            ? { message: 'Too many wrong codes, so that sign-in was cancelled. Sign in with Discord again.', severity: 'bad' }
            : null) ||
        (state.notice ? { message: state.notice, severity: 'warn' } : null) ||
        engineProblem(state) ||
        (state.serverReachable === false ? { message: `Could not reach ${state.selectedServerUrl}`, severity: 'bad' } : null) ||
        installWarning(state);
    showProblem(problem ? problem.message : '', problem ? problem.severity : '');

    elements.moveApp.hidden = !(state.install && state.install.relocate && state.install.canMove);

    // The restart-to-update button appears only when a full update is sitting downloaded;
    // every other state leaves the strip to say what is happening instead.
    elements.updateInstall.hidden = !state.update || state.update.state !== 'downloaded';
    // Builds that cannot install an update get a download link for it instead.
    elements.updateDownload.hidden = !state.update || state.update.state !== 'available';
    if (!elements.updateDownload.hidden) {
        elements.updateDownload.textContent = `Download ${state.update.version}`;
    }
    elements.updateActions.hidden = elements.updateInstall.hidden && elements.updateDownload.hidden;
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
    renderGraphics(state.graphics);
    renderDev(state);
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
    elements.playLegacy.disabled = true;
    const result = await (engine ? window.launcher.play(engine) : window.launcher.play());
    if (!result || !result.ok) {
        showProblem((result && result.message) || 'Could not start the game.', 'bad');
    }
    if (currentState) {
        applyPlayButtons(currentState);
    }
}

elements.play.addEventListener('click', () => {
    void playWith();
});

elements.playLegacy.addEventListener('click', () => {
    void playWith('projector');
});

elements.accountReveal.addEventListener('click', () => {
    emailRevealed = !emailRevealed;
    if (currentState) {
        render(currentState);
    }
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

elements.updateDownload.addEventListener('click', () => {
    void window.launcher.updateDownload();
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

elements.devMode.addEventListener('change', async () => {
    const next = await window.launcher.setDevMode(elements.devMode.checked);
    if (next) {
        render(next);
    }
});

elements.devChoose.addEventListener('click', async () => {
    const next = await window.launcher.devChooseServer();
    if (next && next.dev) {
        render(next);
    }
});

elements.devCreate.addEventListener('click', () => {
    void window.launcher.devCreate();
});

elements.devStop.addEventListener('click', () => {
    void window.launcher.devStop();
});

elements.devCopy.addEventListener('click', async () => {
    const result = await window.launcher.devCopyShare();
    elements.devCopy.textContent = result && result.ok ? 'Copied' : 'Copy';
});

async function playDev(start) {
    const result = await start();
    if (result && !result.ok) {
        showProblem(result.message || 'Could not start the game.', 'bad');
    }
}

elements.devPlayOwn.addEventListener('click', () => {
    void playDev(() => window.launcher.devPlayOwn());
});

elements.devJoin.addEventListener('click', () => {
    void playDev(() => window.launcher.devJoin(String(elements.devJoinAddress.value || '').trim()));
});

elements.devJoinAddress.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        void playDev(() => window.launcher.devJoin(String(elements.devJoinAddress.value || '').trim()));
    }
});

window.launcher.onState(render);
window.launcher.getState().then(render);
