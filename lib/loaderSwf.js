'use strict';

/**
 * A tiny SWF that does one thing: load the game into level 0.
 *
 * Flash Player titles its window after the movie it was started on. Started on the game's
 * URL, that title is the URL itself. Started on this local file instead, the title is the
 * file's name, and the game still arrives from the server: `getURL(url, "_level0")` is
 * AVM1's loadMovieNum(url, 0), which replaces this movie with the game.
 *
 * The SWF is written by hand -- an uncompressed header, a FileAttributes tag with the
 * network flag (so a local file may reach the server), and a single DoAction holding an
 * ActionGetURL. Nothing here needs a Flash compiler.
 */

const TAG_END = 0;
const TAG_SHOW_FRAME = 1;
const TAG_SET_BACKGROUND_COLOR = 9;
const TAG_DO_ACTION = 12;
const TAG_FILE_ATTRIBUTES = 69;

const ACTION_GET_URL = 0x83;
const ACTION_PUSH = 0x96;
const ACTION_SET_PROPERTY = 0x23;
const ACTION_END = 0x00;
const PROPERTY_QUALITY = 19;
const QUALITIES = ['LOW', 'MEDIUM', 'HIGH', 'BEST'];

function action(code, body) {
    const header = Buffer.alloc(3);
    header.writeUInt8(code, 0);
    header.writeUInt16LE(body.length, 1);
    return Buffer.concat([header, body]);
}

// setProperty("", _quality, quality): the stage quality outlives this movie, so the game keeps it.
function setQuality(quality) {
    const index = Buffer.alloc(5);
    index.writeUInt8(1, 0);
    index.writeFloatLE(PROPERTY_QUALITY, 1);
    const push = Buffer.concat([
        Buffer.from([0, 0]),
        index,
        Buffer.from([0]),
        Buffer.from(quality, 'ascii'),
        Buffer.from([0])
    ]);
    return Buffer.concat([action(ACTION_PUSH, push), Buffer.from([ACTION_SET_PROPERTY])]);
}

function tag(code, body = Buffer.alloc(0)) {
    if (body.length < 0x3f) {
        const header = Buffer.alloc(2);
        header.writeUInt16LE((code << 6) | body.length, 0);
        return Buffer.concat([header, body]);
    }
    const header = Buffer.alloc(6);
    header.writeUInt16LE((code << 6) | 0x3f, 0);
    header.writeUInt32LE(body.length, 2);
    return Buffer.concat([header, body]);
}

/** A RECT of four signed twip values, packed as the SWF header wants it. */
function rect(xMin, xMax, yMin, yMax) {
    const values = [xMin, xMax, yMin, yMax];
    const bits = Math.max(...values.map((value) => Math.abs(value).toString(2).length + 1));
    let packed = bits.toString(2).padStart(5, '0');
    for (const value of values) {
        const unsigned = value < 0 ? (1 << bits) + value : value;
        packed += unsigned.toString(2).padStart(bits, '0');
    }
    packed = packed.padEnd(Math.ceil(packed.length / 8) * 8, '0');
    const bytes = [];
    for (let index = 0; index < packed.length; index += 8) {
        bytes.push(Number.parseInt(packed.slice(index, index + 8), 2));
    }
    return Buffer.from(bytes);
}

// FileAttributes flags. UseDirectBlit and UseGPU are how a movie asks the standalone Flash
// Player for hardware rendering -- the projector's own form of wmode "direct" and "gpu".
const FILE_ATTRIBUTE_USE_NETWORK = 0x01;
const FILE_ATTRIBUTE_USE_GPU = 0x20;
const FILE_ATTRIBUTE_USE_DIRECT_BLIT = 0x40;
const RENDER_FLAGS = { '': 0, direct: FILE_ATTRIBUTE_USE_DIRECT_BLIT, gpu: FILE_ATTRIBUTE_USE_GPU };

/**
 * @param {string} url The game SWF.
 * @param {{ width?: number, height?: number, background?: number, render?: string }} [options]
 *   Stage size in pixels and colour, used for the moment before the game replaces this movie.
 *   The default is the game's own stage, so the window does not jump when it arrives.
 *   `render` is '' (software, Flash Player's default), 'direct' or 'gpu'.
 *   `quality` is '' (the game's own) or LOW, MEDIUM, HIGH, BEST.
 * @returns {Buffer}
 */
function buildLoaderSwf(url, { width = 1152, height = 768, background = 0x484955, render = '', quality = '' } = {}) {
    if (!Object.prototype.hasOwnProperty.call(RENDER_FLAGS, render)) {
        throw new Error(`unknown render mode "${render}"`);
    }
    if (quality && !QUALITIES.includes(quality)) {
        throw new Error(`unknown quality "${quality}"`);
    }
    const target = Buffer.from(String(url), 'utf8');
    if (target.includes(0)) {
        throw new Error('the game URL cannot contain a NUL byte');
    }

    const getUrl = Buffer.concat([target, Buffer.from([0]), Buffer.from('_level0', 'ascii'), Buffer.from([0])]);
    const actions = Buffer.concat([
        quality ? setQuality(quality) : Buffer.alloc(0),
        action(ACTION_GET_URL, getUrl),
        Buffer.from([ACTION_END])
    ]);

    const tags = Buffer.concat([
        // UseNetwork: a local file in the local-with-networking sandbox may load from the server.
        tag(TAG_FILE_ATTRIBUTES, Buffer.from([FILE_ATTRIBUTE_USE_NETWORK | RENDER_FLAGS[render], 0, 0, 0])),
        tag(TAG_SET_BACKGROUND_COLOR, Buffer.from([(background >> 16) & 0xff, (background >> 8) & 0xff, background & 0xff])),
        tag(TAG_DO_ACTION, actions),
        tag(TAG_SHOW_FRAME),
        tag(TAG_END)
    ]);

    const frame = Buffer.concat([
        rect(0, width * 20, 0, height * 20),
        Buffer.from([0x00, 24]), // frame rate 24.0 (8.8 fixed point, little-endian)
        Buffer.from([1, 0]) // one frame
    ]);

    const header = Buffer.alloc(8);
    header.write('FWS', 0, 'ascii');
    header.writeUInt8(10, 3); // SWF 10
    header.writeUInt32LE(8 + frame.length + tags.length, 4);

    return Buffer.concat([header, frame, tags]);
}

module.exports = { QUALITIES, RENDER_FLAGS, buildLoaderSwf, rect };
