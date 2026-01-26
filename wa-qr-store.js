const fs = require("fs");
const path = require("path");
const FILE = path.join(__dirname, ".wa-qr.json");

// Status values: 'initializing', 'qr_pending', 'ready', 'disconnected', 'auth_failure'
const defaultState = { qr: null, ready: false, status: 'initializing', ts: Date.now() };

function write(obj) {
  fs.writeFileSync(FILE, JSON.stringify(obj), "utf8");
}

module.exports = {
  setQR(qr) {
    write({ qr, ready: false, status: 'qr_pending', ts: Date.now() });
  },
  setReady() {
    write({ qr: null, ready: true, status: 'ready', ts: Date.now() });
  },
  setDisconnected() {
    write({ qr: null, ready: false, status: 'disconnected', ts: Date.now() });
  },
  setInitializing() {
    write({ qr: null, ready: false, status: 'initializing', ts: Date.now() });
  },
  setAuthFailure() {
    write({ qr: null, ready: false, status: 'auth_failure', ts: Date.now() });
  },
  setStatus(status) {
    const current = this.get();
    write({ ...current, status, ts: Date.now() });
  },
  get() {
    try {
      const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
      // Ensure status field exists for backwards compatibility
      if (!data.status) {
        data.status = data.ready ? 'ready' : (data.qr ? 'qr_pending' : 'disconnected');
      }
      return data;
    } catch {
      return { ...defaultState };
    }
  },
};
