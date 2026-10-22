'use strict';

// Gives the page's Flash <object>/<embed> a quality param before the plugin starts on it.
const { webFrame } = require('electron');

const prefix = '--db-quality=';
const found = process.argv.find((arg) => arg.startsWith(prefix));
const quality = found ? found.slice(prefix.length) : '';

if (quality === 'low' || quality === 'medium') {
    webFrame.executeJavaScript(`(function (quality) {
        function apply(node) {
            if (!node || node.nodeType !== 1) {
                return;
            }
            var tag = node.tagName;
            if (tag === 'EMBED') {
                node.setAttribute('quality', quality);
            } else if (tag === 'OBJECT' && /shockwave-flash/i.test(node.type || '')) {
                var params = node.getElementsByTagName('param');
                for (var i = 0; i < params.length; i++) {
                    if (String(params[i].name).toLowerCase() === 'quality') {
                        params[i].value = quality;
                        return;
                    }
                }
                var param = document.createElement('param');
                param.name = 'quality';
                param.value = quality;
                insertBefore.call(node, param, node.firstChild);
            }
        }
        var appendChild = Node.prototype.appendChild;
        var insertBefore = Node.prototype.insertBefore;
        var replaceChild = Node.prototype.replaceChild;
        Node.prototype.appendChild = function (node) {
            apply(node);
            return appendChild.call(this, node);
        };
        Node.prototype.insertBefore = function (node, child) {
            apply(node);
            return insertBefore.call(this, node, child);
        };
        Node.prototype.replaceChild = function (node, child) {
            apply(node);
            return replaceChild.call(this, node, child);
        };
    })(${JSON.stringify(quality)});`);
}
