const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');

// Replay today's host implementation against the frozen historical binary.
// Only release metadata and the resource path are replaced in an isolated test
// module. Production exports and its integrity check are not modified.
module.exports = function loadHistoricalTsdk(fixture) {
    const filename = require.resolve('../../dist/utils/tsdk-runtime');
    const realRequire = createRequire(filename);
    let source = fs.readFileSync(filename, 'utf8');
    for (const [name, value] of [['TSDK_VERSION', fixture.version], ['TSDK_SHA256', fixture.sha256]]) {
        const declaration = new RegExp(`^const ${name} = [^;]+;`, 'm');
        assert.match(source, declaration, `Historical harness must recognize ${name}`);
        source = source.replace(declaration, `const ${name} = ${JSON.stringify(value)};`);
    }
    const isolated = new Module(filename, module);
    isolated.filename = filename;
    isolated.require = (name) => {
        const dependency = realRequire(name);
        if (name !== '../config/runtime-paths') return dependency;
        return {
            ...dependency,
            getResourcePath(...parts) {
                if (parts.length === 2 && parts[0] === 'utils' && parts[1] === 'tsdk.wasm') return path.join(__dirname, fixture.file);
                return dependency.getResourcePath(...parts);
            },
        };
    };
    isolated._compile(source, filename);
    return isolated.exports;
};
