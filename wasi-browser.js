// Modified deno-wasi implementation for browser
// https://github.com/caspervonb/deno-wasi
// https://github.com/guest271314/deno-wasi/tree/runtime-agnostic-nodejs-api

const process = { exit: (_) => {} };
const encoder = new TextEncoder();

const readSync = (fd, data) => {
  if (fd.byteLength === 0) return fd.byteLength;
  const bytesRead = fd.byteLength;
  const dataView = new DataView(fd);
  for (let i = 0; i < fd.byteLength; i++) {
    data[i] = dataView.getUint8(i);
  }
  fd.resize(0);
  return bytesRead;
};

const writeSync = (fd, data) => {
  fd.resize(data.length);
  const dataView = new DataView(fd);
  for (let i = 0; i < data.length; i++) {
    dataView.setUint8(i, data[i]);
  }
  return fd.byteLength;
};

const CLOCKID_REALTIME = 0;
const CLOCKID_MONOTONIC = 1;
const CLOCKID_PROCESS_CPUTIME_ID = 2;
const CLOCKID_THREAD_CPUTIME_ID = 3;
const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_INVAL = 28;
const ERRNO_NOSYS = 52;
const ERRNO_NOTDIR = 54;
const RIGHTS_FD_DATASYNC = 0x0000000000000001n;
const RIGHTS_FD_READ = 0x0000000000000002n;
const RIGHTS_FD_WRITE = 0x0000000000000040n;
const RIGHTS_FD_ALLOCATE = 0x0000000000000100n;
const RIGHTS_FD_READDIR = 0x0000000000004000n;
const RIGHTS_FD_FILESTAT_SET_SIZE = 0x0000000000400000n;
const FILETYPE_UNKNOWN = 0;
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;
const FILETYPE_SYMBOLIC_LINK = 7;
const FDFLAGS_APPEND = 0x0001;
const FDFLAGS_DSYNC = 0x0002;
const FDFLAGS_NONBLOCK = 0x0004;
const FDFLAGS_RSYNC = 0x0008;
const FDFLAGS_SYNC = 0x0010;
const FSTFLAGS_ATIM_NOW = 0x0002;
const FSTFLAGS_MTIM_NOW = 0x0008;
const OFLAGS_CREAT = 0x0001;
const OFLAGS_DIRECTORY = 0x0002;
const OFLAGS_EXCL = 0x0004;
const OFLAGS_TRUNC = 0x0008;
const PREOPENTYPE_DIR = 0;
const clock_res_realtime = function () {
  return BigInt(1e6);
};
const clock_res_monotonic = function () {
  return BigInt(1e3);
};
const clock_res_process = clock_res_monotonic;
const clock_res_thread = clock_res_monotonic;
const clock_time_realtime = function () {
  return BigInt(Date.now()) * BigInt(1e6);
};
const clock_time_monotonic = function () {
  const t = performance.now();
  const s = Math.trunc(t);
  const ms = Math.floor((t - s) * 1e3);
  return BigInt(s) * BigInt(1e9) + BigInt(ms) * BigInt(1e6);
};
const clock_time_process = clock_time_monotonic;
const clock_time_thread = clock_time_monotonic;

function errno(err) {
  switch (err.name) {
    case "NotFound":
      return 44;
    case "PermissionDenied":
      return 2;
    case "ConnectionRefused":
      return 14;
    case "ConnectionReset":
      return 15;
    case "ConnectionAborted":
      return 13;
    case "NotConnected":
      return 53;
    case "AddrInUse":
      return 3;
    case "AddrNotAvailable":
      return 4;
    case "BrokenPipe":
      return 64;
    case "InvalidData":
      return 28;
    case "TimedOut":
      return 73;
    case "Interrupted":
      return 27;
    case "BadResource":
      return 8;
    case "Busy":
      return 10;
    default:
      return 28;
  }
}
class WASI {
  args;
  env;
  memory;
  fds;
  exports;
  constructor(options) {
    this.args = options?.args ? options.args : [];
    this.env = options?.env ? options.env : {};
    this.memory = options?.memory;
    this.fds = [
      {
        type: FILETYPE_CHARACTER_DEVICE,
        handle: options.stdin,
      },
      {
        type: FILETYPE_CHARACTER_DEVICE,
        handle: options.stdout,
      },
      {
        type: FILETYPE_CHARACTER_DEVICE,
        handle: options.stderr,
      },
    ];
    this.exports = {
      clock_time_get: (id, precision, time_out) => {
        const view = new DataView(this.memory.buffer);
        switch (id) {
          case CLOCKID_REALTIME:
            view.setBigUint64(time_out, clock_time_realtime(), true);
            break;
          case CLOCKID_MONOTONIC:
            view.setBigUint64(time_out, clock_time_monotonic(), true);
            break;
          case CLOCKID_PROCESS_CPUTIME_ID:
            view.setBigUint64(time_out, clock_time_process(), true);
            break;
          case CLOCKID_THREAD_CPUTIME_ID:
            view.setBigUint64(time_out, clock_time_thread(), true);
            break;
          default:
            return ERRNO_INVAL;
        }
        return ERRNO_SUCCESS;
      },
      environ_get: (environ_ptr, environ_buf_ptr) => {
        const entries = Object.entries(this.env);
        const heap = new Uint8Array(this.memory.buffer);
        const view = new DataView(this.memory.buffer);
        for (let [key, value] of entries) {
          view.setUint32(environ_ptr, environ_buf_ptr, true);
          environ_ptr += 4;
          const data = encoder.encode(`${key}=${value}\x00`);
          heap.set(data, environ_buf_ptr);
          environ_buf_ptr += data.length;
        }
        return ERRNO_SUCCESS;
      },
      environ_sizes_get: (environc_out, environ_buf_size_out) => {
        const entries = Object.entries(this.env);
        const view = new DataView(this.memory.buffer);
        view.setUint32(environc_out, entries.length, true);
        view.setUint32(
          environ_buf_size_out,
          entries.reduce(function (acc, [key, value]) {
            return acc + encoder.encode(`${key}=${value}\x00`).length;
          }, 0),
          true,
        );
        return ERRNO_SUCCESS;
      },
      fd_close: (fd) => {
        const entry = this.fds[fd];
        if (!entry) {
          return ERRNO_BADF;
        }
        entry.handle.resize(0);
        delete this.fds[fd];
        return ERRNO_SUCCESS;
      },
      fd_fdstat_get: (fd, stat_out) => {
        const entry = this.fds[fd];
        if (!entry) {
          return ERRNO_BADF;
        }
        const view = new DataView(this.memory.buffer);
        view.setUint8(stat_out, entry.type);
        view.setUint16(stat_out + 4, 0, true);
        view.setBigUint64(stat_out + 8, 0n, true);
        view.setBigUint64(stat_out + 16, 0n, true);
        return ERRNO_SUCCESS;
      },
      fd_read: (fd, iovs_ptr, iovs_len, nread_out) => {
        const entry = this.fds[fd];
        if (!entry) {
          return ERRNO_BADF;
        }
        const view = new DataView(this.memory.buffer);
        let nread = 0;
        for (let i = 0; i < iovs_len; i++) {
          const data_ptr = view.getUint32(iovs_ptr, true);
          iovs_ptr += 4;
          const data_len = view.getUint32(iovs_ptr, true);
          iovs_ptr += 4;
          const data = new Uint8Array(this.memory.buffer, data_ptr, data_len);
          nread += readSync(entry.handle, data);
        }
        view.setUint32(nread_out, nread, true);
        return ERRNO_SUCCESS;
      },
      fd_write: (fd, iovs_ptr, iovs_len, nwritten_out) => {
        const entry = this.fds[fd];
        if (!entry) {
          return ERRNO_BADF;
        }
        const view = new DataView(this.memory.buffer);
        let nwritten = 0;
        for (let i = 0; i < iovs_len; i++) {
          const data_ptr = view.getUint32(iovs_ptr, true);
          iovs_ptr += 4;
          const data_len = view.getUint32(iovs_ptr, true);
          iovs_ptr += 4;
          nwritten += writeSync(
            entry.handle,
            new Uint8Array(this.memory.buffer, data_ptr, data_len),
          );
        }
        view.setUint32(nwritten_out, nwritten, true);
        return ERRNO_SUCCESS;
      },
      fd_seek: (fd, offset, whence, newoffset_out) => {
        const entry = this.fds[fd];
        if (!entry) {
          return ERRNO_BADF;
        }
        const view = new DataView(this.memory.buffer);
        try {
          const newoffset = entry.handle.seekSync(Number(offset), whence);
          view.setBigUint64(newoffset_out, BigInt(newoffset), true);
        } catch (err) {
          return ERRNO_INVAL;
        }
        return ERRNO_SUCCESS;
      },
      proc_exit: (rval) => {
        process.exit(rval);
      },
      random_get: (buf_ptr, buf_len) => {
        const buffer = new Uint8Array(this.memory.buffer, buf_ptr, buf_len);
        crypto.getRandomValues(buffer);
        return ERRNO_SUCCESS;
      },
    };
  }
}
export { WASI, WASI as default };
