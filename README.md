# Embedding Javy in Browser Application

This example demonstrates how to run Javy in a browser host application.

Based on [Embedding in Node.js Application](https://github.com/bytecodealliance/javy/blob/main/docs/docs-using-nodejs.md).

## Warning

This example does NOT show how to run a browser application in Javy. This is
useful for when you want to run untrusted user generated code in a sandbox. This
code is meant to be an example not production-ready code.

It's also important to note that the WASI implementation `wasi-browser.js` is a
[polyfill] adapted for use in the browser.

[polyfill]: https://github.com/guest271314/deno-wasi/tree/runtime-agnostic-nodejs-api

## Summary

This example shows how to use a dynamically linked Javy compiled Wasm module. We
use std in/out/error to communicate with the embedded javascript. See
[this blog post](https://k33g.hashnode.dev/wasi-communication-between-nodejs-and-wasm-modules-another-way-with-stdin-and-stdout)
for details. In this browser example [resizable `ArrayBuffer`s] are used for
I/O.

[resizable `ArrayBuffer`s]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer/resizable

### Steps

1. Emit the Javy plugin

```shell
javy emit-plugin -o plugin.wasm
```

2. Compile the `embedded.js` with Javy using dynamic linking:

```shell
javy build -C dynamic -C plugin=plugin.wasm -o embedded.wasm embedded.js
```

3. Run `host-browser.js`

### Running on `file:` protocol

#### Chrome

```shell
chrome --allow-file-access-from-files index.html
```

Headless

```shell
chrome --headless --password-store=basic --enable-logging=stderr --disable-gpu 
--allow-file-access-from-files index.html 2>&1
```

The result is written to the HTML `document` and logged to `console`.

#### Firefox

Navigate to `about:config`, set `security.fileuri.strict_origin_policy` to
`false` and `devtools.console.stdout.content` to `true`.

```shell
firefox-bin -P default-nightly index.html
```

Headless

```
firefox-bin -headless -P default-nightly index.html | grep console.log
```

`embedded.js`

```javascript
// Read input from stdin
const input = readInput();
// Call the function with the input
const result = foo(input);
// Write the result to stdout
writeOutput(result);

// The main function.
function foo(input) {
  if (input && typeof input === "object" && typeof input.n === "number") {
    return { n: input.n + 1 };
  }
  return { n: 0 };
}

// Read input from stdin
function readInput() {
  const chunkSize = 1024;
  const inputChunks = [];
  let totalBytes = 0;

  // Read all the available bytes
  while (1) {
    const buffer = new Uint8Array(chunkSize);
    // Stdin file descriptor
    const fd = 0;
    const bytesRead = Javy.IO.readSync(fd, buffer);

    totalBytes += bytesRead;
    if (bytesRead === 0) {
      break;
    }
    inputChunks.push(buffer.subarray(0, bytesRead));
  }

  // Assemble input into a single Uint8Array
  const { finalBuffer } = inputChunks.reduce(
    (context, chunk) => {
      context.finalBuffer.set(chunk, context.bufferOffset);
      context.bufferOffset += chunk.length;
      return context;
    },
    { bufferOffset: 0, finalBuffer: new Uint8Array(totalBytes) },
  );

  const maybeJson = new TextDecoder().decode(finalBuffer);
  try {
    return JSON.parse(maybeJson);
  } catch {
    return;
  }
}

// Write output to stdout
function writeOutput(output) {
  const encodedOutput = new TextEncoder().encode(JSON.stringify(output));
  const buffer = new Uint8Array(encodedOutput);
  // Stdout file descriptor
  const fd = 1;
  Javy.IO.writeSync(fd, buffer);
}
```

`host-browser.js`

```javascript
import { WASI } from "./wasi-browser.js";

async function runWasm(e) {
  const stdin = new ArrayBuffer(0, { maxByteLength: 8192 });
  const stdout = new ArrayBuffer(0, { maxByteLength: 8192 });
  const stderr = new ArrayBuffer(0, { maxByteLength: 8192 });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  try {
    const [embeddedModule, pluginModule] = await Promise.all([
      compileModule("embedded.wasm"),
      compileModule("plugin.wasm"),
    ]);

    const result = JSON.stringify(
      await runJavy(pluginModule, embeddedModule, { n: 100 }),
      null,
      2,
    );
    console.log(result);
    document.querySelector("output")
      .textContent = result;
  } catch (e) {
    console.log(e);
  }

  async function readFile(fileName) {
    return await (await fetch(fileName)).bytes();
  }

  async function compileModule(wasmPath) {
    const bytes = await readFile(wasmPath);
    return WebAssembly.compile(bytes);
  }

  async function runJavy(pluginModule, embeddedModule, input) {
    // Use stdin/stdout/stderr to communicate with Wasm instance
    // See https://k33g.hashnode.dev/wasi-communication-between-nodejs-and-wasm-modules-another-way-with-stdin-and-stdout
    // 👋 send data to the Wasm instance
    writeFile(stdin, JSON.stringify(input));

    const wasiOptions = {
      stdin,
      stdout,
      stderr,
    };

    try {
      const wasi = new WASI(wasiOptions);

      const pluginInstance = await WebAssembly.instantiate(
        pluginModule,
        { wasi_snapshot_preview1: wasi.exports },
      ).catch(console.log);

      const instance = await WebAssembly.instantiate(embeddedModule, {
        "javy-default-plugin-v3": pluginInstance.exports,
      }).catch(console.log);

      wasi.memory = pluginInstance.exports.memory;
      // Javy plugin is a WASI reactor see https://github.com/WebAssembly/WASI/blob/main/legacy/application-abi.md?plain=1
      instance.exports._start();

      const [out, err] = await Promise.all([
        readOutput(stdout),
        readOutput(stderr),
      ]);
      if (err) {
        throw new Error(err);
      }

      return out;
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) {
        const errorMessage = await readOutput(stderr);
        if (errorMessage) {
          throw new Error(errorMessage);
        }
      }
      throw e;
    } finally {
      stdin.resize(0);
      stdout.resize(0);
      stderr.resize(0);
    }
  }

  async function readOutput(fd) {
    try {
      if (fd.byteLength) {
        const dataView = new DataView(fd);
        const u8 = Uint8Array.from({ length: fd.byteLength }, (_, i) => {
          return dataView.getUint8(i);
        });
        const str = decoder.decode(u8);
        return JSON.parse(str);
      }
    } catch {
      return fd;
    }
  }

  function writeFile(buffer, data) {
    const input = encoder.encode(data);
    buffer.resize(input.length);
    const u8 = new Uint8Array(buffer);
    u8.set(input);
    return u8;
  }
}

document.querySelector("button").addEventListener("click", runWasm);
// Run on document load
runWasm().catch(console.log);
export {};
```
# License
Do What the Fuck You Want to Public License [WTFPLv2](http://www.wtfpl.net/about/)