#!/usr/bin/env node
'use strict';

/**
 * Starts FlashBrowser exactly as the launcher does (lib/flashBrowser.js) on a local test page
 * that embeds a SWF, and checks that Flash is running it -- the proof that Electron 11 loaded
 * FlashBrowser's PPAPI plugin from vendor/flashbrowser/, not just that a window opened.
 *
 * navigator.plugins is not that proof: Chromium lists "Shockwave Flash" for whatever path
 * --ppapi-flash-path names, even one with no file behind it. Only a plugin that actually
 * loaded answers the movie's scripting calls (PercentLoaded), so that is what is asked.
 *
 * Run by the FlashBrowser workflow on Windows and macOS runners, which have a desktop, after
 * tools/fetch-flash-browser.js.
 *
 * Usage: node tools/check-flash-browser.js
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { findFlashBrowser, prepareFlashBrowserLaunch } = require('../lib/flashBrowser');
const { buildLoaderSwf } = require('../lib/loaderSwf');

// The page gives the plugin 30 seconds; this covers the window starting as well.
const TIMEOUT_MS = 90 * 1000;

// What the page reports: the plugins Chromium registered, and whether the embedded movie is
// being run by Flash -- whether it answers PercentLoaded(), which only a loaded plugin does.
const PAGE = `<!DOCTYPE html>
<html><head><title>FlashBrowser check</title></head><body>
<embed id="movie" type="application/x-shockwave-flash" src="/check.swf" width="320" height="200">
<script>
  var names = Array.prototype.map.call(navigator.plugins, function (plugin) { return plugin.name; });
  var started = Date.now();
  function report(result) {
    result.plugins = names;
    result.agent = navigator.userAgent;
    fetch('/report', { method: 'POST', body: JSON.stringify(result) });
  }
  (function poll() {
    var movie = document.getElementById('movie');
    var percent = null;
    try {
      percent = typeof movie.PercentLoaded === 'function' ? movie.PercentLoaded() : null;
    } catch (error) {
      percent = null;
    }
    if (percent !== null) {
      report({ flash: true, percentLoaded: percent });
    } else if (Date.now() - started > 30000) {
      report({ flash: false });
    } else {
      setTimeout(poll, 500);
    }
  })();
</script>
</body></html>`;

function serve(onReport) {
    const server = http.createServer((request, response) => {
        if (request.method === 'POST' && request.url === '/report') {
            let body = '';
            request.on('data', (chunk) => {
                body += chunk;
            });
            request.on('end', () => {
                response.end('ok');
                try {
                    onReport(JSON.parse(body));
                } catch {
                    onReport({ plugins: [], flash: false, agent: '', unreadable: body });
                }
            });
            return;
        }
        if (request.url === '/check.swf') {
            // A movie that asks for one more file and stays put when it is not there.
            const origin = `http://${request.headers.host}`;
            response.setHeader('Content-Type', 'application/x-shockwave-flash');
            response.end(buildLoaderSwf(`${origin}/missing.swf`));
            return;
        }
        if (request.url !== '/') {
            response.statusCode = 404;
            response.end();
            return;
        }
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(PAGE);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function check(found) {
    let report = null;
    let reported;
    const reportArrived = new Promise((resolve) => {
        reported = resolve;
    });
    const server = await serve((body) => {
        report = body;
        reported();
    });
    const gameUrl = `http://127.0.0.1:${server.address().port}/`;
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-flashbrowser-check-'));
    const launch = prepareFlashBrowserLaunch(found, { gameUrl, userDataDir });
    console.log(`[check-flash-browser] ${launch.command} ${launch.args.join(' ')}`);

    const child = spawn(launch.command, launch.args, { env: launch.env, stdio: 'inherit' });
    let exited = null;
    const childExited = new Promise((resolve) => {
        child.once('exit', (code, signal) => {
            exited = signal || `code ${code}`;
            resolve();
        });
    });
    const timedOut = new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS));
    await Promise.race([reportArrived, childExited, timedOut]);

    try {
        child.kill();
    } catch {
        // Already gone.
    }
    server.close();

    if (!report) {
        throw new Error(exited ? `FlashBrowser exited (${exited}) before the page reported` : 'the page never reported');
    }
    console.log(`[check-flash-browser] ${report.agent}`);
    console.log(`[check-flash-browser] plugins: ${report.plugins.join(', ') || '(none)'}`);
    if (!report.flash) {
        throw new Error('Flash is not running the embedded movie: the plugin did not load');
    }
    console.log(`[check-flash-browser] Flash runs the embedded movie (PercentLoaded ${report.percentLoaded}): OK`);
}

async function main() {
    const located = findFlashBrowser();
    if (!located.offered) {
        throw new Error(`there is no FlashBrowser for ${process.platform}-${process.arch}`);
    }
    if (!located.found) {
        const missing = located.partial ? `: missing ${located.partial.missing.join(', ')}` : '';
        throw new Error(`no FlashBrowser in vendor/flashbrowser/${located.target}${missing}. Run tools/fetch-flash-browser.js first.`);
    }
    await check(located.found);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[check-flash-browser] FAILED: ${error.message}`);
        process.exit(1);
    });
}

module.exports = { check };
