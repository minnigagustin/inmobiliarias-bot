const fs = require("fs");
const path = require("path");
const FILE = path.join(__dirname, ".wa-qr.json");

function write(obj) {
  fs.writeFileSync(FILE, JSON.stringify(obj), "utf8");
}

module.exports = {
  setQR(qr) {
    write({ qr, ready: false, ts: Date.now() });
  },
  setReady() {
    write({ qr: null, ready: true, ts: Date.now() });
  },
  get() {
    try {
      return JSON.parse(fs.readFileSync(FILE, "utf8"));
    } catch {
      return { qr: null, ready: false };
    }
  },
};
