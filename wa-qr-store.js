// wa-qr-store.js
let lastQR = null;
let ready = false;

module.exports = {
  setQR(qr) {
    lastQR = qr;
    ready = false;
  },
  setReady() {
    ready = true;
    lastQR = null;
  },
  get() {
    return { qr: lastQR, ready };
  },
};
