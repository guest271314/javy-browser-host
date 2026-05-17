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
