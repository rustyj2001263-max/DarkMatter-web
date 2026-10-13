const { merge } = require('webpack-merge');

const common = require('./webpack.common');

// Jellyfin serves stylesheets as plain "text/css" without a charset, so clients that
// do not assume UTF-8 garble the raw icon-font characters in the CSS. Declare the
// encoding in every stylesheet that contains non-ASCII characters.
class CssCharsetPlugin {
    apply(compiler) {
        const { Compilation, sources } = compiler.webpack;

        compiler.hooks.thisCompilation.tap('CssCharsetPlugin', compilation => {
            compilation.hooks.processAssets.tap({
                name: 'CssCharsetPlugin',
                stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE
            }, assets => {
                for (const name of Object.keys(assets)) {
                    if (!name.endsWith('.css')) continue;

                    const css = assets[name].source().toString();
                    if (css.startsWith('@charset') || !/[\u0080-\uFFFF]/.test(css)) continue;

                    compilation.updateAsset(name, new sources.RawSource(`@charset "UTF-8";${css.charCodeAt(0) === 0xFEFF ? css.slice(1) : css}`));
                }
            });
        });
    }
}

module.exports = merge(common, {
    mode: 'production',
    entry: {
        ...common.entry,
        'serviceworker': './serviceworker.js'
    },
    plugins: [
        new CssCharsetPlugin()
    ]
});
