// Forwards engine frames to backend ingest.
// Sends every 10th frame to match the 10 Hz contract.
// Source and target use env overrides.
const WebSocket = require("ws");

const UP = process.env.ENGINE_WS || "ws://localhost:8000/engine";
const DOWN = process.env.INGEST_WS || "ws://localhost:8080";

let n = 0,
  dropped = 0;
let down = null;
const t0 = Date.now();

function connect() {
  const openDown = () => {
    down = new WebSocket(DOWN);
    // Clears the socket on error so the watchdog can reopen it.
    // Close handler retries the connection.
    down.on("error", () => { down = null; });
    down.on("close", () => {
      down = null;
      setTimeout(openDown, 2000);
    });
  };
  openDown();
  const up = new WebSocket(UP);
  up.on("message", (data) => {
    n++;
    // Control flags bypass downsampling.
    // A single stop frame closes the mission.
    let urgent = false;
    try {
      const j = JSON.parse(data.toString());
      // Parked frames run at 10 Hz.
      // Forwarded without downsampling.
      urgent = j.end_of_mission === true || j.parked === true;
    } catch {}
    if (!urgent && n % 10 !== 0) {
      dropped++;
      return; // downsamples 100 Hz to 10 Hz
    }
    if (down && down.readyState === WebSocket.OPEN) down.send(data.toString());
  });
  up.on("close", () => setTimeout(connect, 2000));
  up.on("error", () => {});
  console.log(`[bridge] ${UP} -> ${DOWN} (1-in-10)`);
}
setInterval(() => {
  const el = (Date.now() - t0) / 1000;
  console.log(
    `[bridge] fwd ${n - dropped} frames (${((n - dropped) / el).toFixed(1)}/s)`,
  );
}, 30000);
// Watchdog clears closed sockets missed by event handlers.
// Open and connecting sockets stay untouched.
setInterval(() => {
  if (
    down &&
    (down.readyState === WebSocket.CLOSED ||
      down.readyState === WebSocket.CLOSING)
  )
    down = null;
}, 5000);
connect();
