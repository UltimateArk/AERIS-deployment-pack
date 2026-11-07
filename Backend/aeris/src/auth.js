// Operator login with sliding tokens.
// HMAC signed tokens with 30 minute access window.
// Signing secret persists on disk across restarts.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const C = require("./config");

const ACCESS_MS = 30 * 60 * 1000; // 30 minute token lifetime
const REFRESH_GRACE_MS = 12 * 60 * 60 * 1000; // 12 hour refresh window

// User list.
const USERS = (() => {
  if (process.env.AUTH_USERS) {
    try { return JSON.parse(process.env.AUTH_USERS); } catch { /* fall through */ }
  }
  return { pilot: "aeris" };
})();

// Signing secret.
const SECRET = (() => {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const f = path.join(C.paths.data, "auth.secret");
  try {
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
    const s = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  } catch {
    return crypto.randomBytes(32).toString("hex");
  }
})();

const b64 = (buf) => Buffer.from(buf).toString("base64url");
const sign = (data) => crypto.createHmac("sha256", SECRET).update(data).digest("base64url");

function issue(username) {
  const payload = { u: username, iat: Date.now(), exp: Date.now() + ACCESS_MS };
  const body = b64(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

function verify(token, { grace = 0 } = {}) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expect = sign(body);
  const a = Buffer.from(mac || "");
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (Date.now() > p.exp + grace) return null;
    return p;
  } catch {
    return null;
  }
}

// Compares credentials in constant time.
function login(username, password) {
  const want = USERS[username];
  if (!want) return null;
  const a = crypto.createHash("sha256").update(String(password)).digest();
  const b = crypto.createHash("sha256").update(String(want)).digest();
  if (!crypto.timingSafeEqual(a, b)) return null;
  return issue(username);
}

function refresh(token) {
  const p = verify(token, { grace: REFRESH_GRACE_MS });
  if (!p) return null;
  return issue(p.u);
}

module.exports = { login, verify, refresh, issue, ACCESS_MS, USERS: Object.keys(USERS) };
