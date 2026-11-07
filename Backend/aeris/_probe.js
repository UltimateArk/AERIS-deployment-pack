const http = require("http");
function req(method, path, body, headers = {}) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "localhost", port: 8081, path, method,
      headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}), ...headers } },
      (x) => { let b = ""; x.on("data", (c) => (b += c)); x.on("end", () => { try { res({ status: x.statusCode, body: JSON.parse(b) }); } catch { res({ status: x.statusCode, body: b }); } }); });
    r.on("error", rej); if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const lg = await req("POST", "/api/auth/login", { username: "pilot", password: "aeris" });
  const H = { Authorization: "Bearer " + lg.body.token };
  const s = await req("POST", "/api/session/start", { name: "LIFECYCLE", engineId: "ENG-01", pilot: "pilot" }, H);
  console.log("session/start:", s.status, JSON.stringify(s.body));
  let h = await req("GET", "/health", null, {});
  console.log("pre-start  health: mission=", h.body.mission, "session=", h.body.session?.name);
  await req("POST", "/api/start", {}, H);
  await req("POST", "/api/controls", { rpm: 5500, load: 60 }, H);
  await sleep(2500);
  h = await req("GET", "/health", null, {});
  console.log("post-start health: mission=", h.body.mission, "session=", h.body.session?.name);
  const ab = await req("POST", "/api/session/abort?token=" + encodeURIComponent(lg.body.token), {}, {});
  console.log("abort:", ab.status, JSON.stringify(ab.body));
  await sleep(1000);
  h = await req("GET", "/health", null, {});
  console.log("post-abort health: mission=", h.body.mission, "session=", h.body.session?.name);
  const sessions = await req("GET", "/api/sessions", null, H);
  const last = (sessions.body || []).find((x) => x.name === "LIFECYCLE");
  console.log("session row:", last ? `${last.name} status=${last.status}` : "none");
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
