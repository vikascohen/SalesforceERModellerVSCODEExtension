// Bundles the extension host (src/extension.ts and everything it
// imports, including exceljs) into a single dist/extension.js.
// 'vscode' stays external -- it's provided by the VS Code runtime
// itself, never bundled, the same way every VS Code extension treats it.
//
// Why this exists: without it, `vsce package` ships the ENTIRE
// node_modules folder into the .vsix (2000+ files, ~16MB, including dev
// dependencies like jest, babel and typescript that are never needed at
// runtime) since vsce has no reliable way to know which installed
// packages are actually used by the code versus just present. Bundling
// produces one small, tree-shaken file with only the code actually
// reachable from extension.ts, so node_modules doesn't need to ship at
// all -- exactly what vsce's own "you should bundle your extension"
// warning recommends.
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    minify: !watch
};

async function run() {
    if (watch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        console.log('esbuild watching...');
    } else {
        await esbuild.build(buildOptions);
        console.log('esbuild build complete.');
    }
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
