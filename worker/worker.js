function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(env) {
  const allowedOrigin = env.SUPPRESS_CORS ? null : env.RESPONSE_ORIGIN || allowedOrigins(env)[0];
  return {
    ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin } : {}),
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  return !origin || allowedOrigins(env).includes(origin);
}

function publicError(status, message, code) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

async function readJson(request, maxBytes = 64 * 1024, { allowEmpty = false } = {}) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    if (allowEmpty && !request.body) return {};
    throw publicError(415, "JSON 형식의 요청만 사용할 수 있습니다.", "UNSUPPORTED_MEDIA_TYPE");
  }
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw publicError(413, "요청 데이터가 너무 큽니다.", "REQUEST_TOO_LARGE");
  }
  const text = await request.text();
  if (!text && allowEmpty) return {};
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw publicError(413, "요청 데이터가 너무 큽니다.", "REQUEST_TOO_LARGE");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw publicError(400, "올바른 JSON 형식이 아닙니다.", "INVALID_JSON");
  }
}

// Request-scoped timings contain only operation names, durations and call counts.
async function externalFetch(env, name, input, init) {
  const start = performance.now();
  try { return await fetch(input, init); }
  finally {
    if (env.TIMINGS) {
      const entry = env.TIMINGS[name] ||= { duration: 0, count: 0 };
      entry.duration += performance.now() - start;
      entry.count++;
    }
  }
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

// ---------- GitHub Contents API 헬퍼 ----------

function ghUrl(env, path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encoded}`;
}

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "work-plan-app-worker",
  };
}

// base64 <-> unicode 안전 변환
function b64EncodeUnicode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64DecodeUnicode(str) {
  return decodeURIComponent(escape(atob(str)));
}

async function ghGetFile(env, path) {
  const res = await externalFetch(env, "github_read", ghUrl(env, path) + `?ref=${env.GITHUB_BRANCH || "main"}`, {
    headers: ghHeaders(env),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET 실패 (${path}): ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { sha: data.sha, contentRaw: data.content };
}

async function ghGetJson(env, path) {
  const file = await ghGetFile(env, path);
  if (!file) return null;
  const text = b64DecodeUnicode(file.contentRaw.replace(/\n/g, ""));
  return { json: JSON.parse(text), sha: file.sha };
}

async function ghPutJson(env, path, obj, sha, message) {
  const body = {
    message: message || `update ${path}`,
    content: b64EncodeUnicode(JSON.stringify(obj, null, 2)),
    branch: env.GITHUB_BRANCH || "main",
  };
  if (sha) body.sha = sha;
  const res = await externalFetch(env, "github_write", ghUrl(env, path), {
    method: "PUT",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`GitHub PUT 실패 (${path}): ${res.status} ${errText}`);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

async function ghPutBinaryBase64(env, path, base64Content, sha, message) {
  const body = {
    message: message || `upload ${path}`,
    content: base64Content,
    branch: env.GITHUB_BRANCH || "main",
  };
  if (sha) body.sha = sha;
  const res = await externalFetch(env, "github_write", ghUrl(env, path), {
    method: "PUT",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub 이미지 업로드 실패: ${res.status} ${await res.text()}`);
  return await res.json();
}

// 바이너리(이미지) 파일을 base64 문자열로 가져오기
async function ghGetBinaryBase64(env, path) {
  const res = await externalFetch(env, "github_read", ghUrl(env, path) + `?ref=${env.GITHUB_BRANCH || "main"}`, {
    headers: { ...ghHeaders(env), Accept: "application/vnd.github.raw+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub 이미지 조회 실패 (${path}): ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ADMIN 계정 판별: Cloudflare 변수 ADMIN_EMAILS(쉼표로 구분)에 등록된 이메일
function isAdminEmail(env, email) {
  return String(env.ADMIN_EMAILS || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
    .includes(String(email || "").toLowerCase());
}

// ---------- 사용자 단계(권한) 체계 ----------
//  1) vendor  : 협력업체
//  2) hyundai : 현대건설(주) — 협력업체 기능 포함 + 가입 승인, 승인, 반려, 삭제
//  3) hyundai + ADMIN : 현대건설(주)의 하위 개념 — ADMIN_EMAILS 등록 계정. 현대건설 기능 포함 + 사용자 관리
const HYUNDAI_COMPANY = "현대건설(주)";

function normalizeCompanyName(name) {
  return String(name || "")
    .replace(/\s+/g, "")
    .replace(/[(（]주[)）]/g, "")
    .replace(/㈜/g, "")
    .replace(/주식회사/g, "");
}
// "현대건설"과 같은 회사인데 표기만 다른 이름 ("현대건설", "(주)현대건설" ...). 정식 이름 "현대건설(주)"는 제외
function isHyundaiLookalike(name) {
  return normalizeCompanyName(name) === "현대건설" && String(name || "").trim() !== HYUNDAI_COMPANY;
}
function orgFromCompany(company) {
  return String(company || "").trim() === HYUNDAI_COMPANY ? "hyundai" : "vendor";
}
// 저장된 기록 기준 단계 (ADMIN 여부는 반영하지 않음)
function recordOrg(record) {
  if (!record) return "vendor";
  return record.org === "hyundai" || String(record.company || "").trim() === HYUNDAI_COMPANY ? "hyundai" : "vendor";
}
// 실제 적용 단계: ADMIN은 회사명과 무관하게 항상 hyundai
function effectiveOrg(env, email, record) {
  return isAdminEmail(env, email) ? "hyundai" : recordOrg(record);
}
function tierOf(env, email, record) {
  return isAdminEmail(env, email) ? "admin" : recordOrg(record);
}

// 로그인 응답과 보호 API가 동일한 계정 상태 규칙을 사용하도록 한 곳에서 판정한다.
// org/tier는 역할이고 status는 가입 승인 상태이므로 서로 대신해서 사용하지 않는다.
export function accountStatusOf(record) {
  if (!record) return "not_registered";
  return ["pending", "rejected", "suspended", "approved"].includes(record.status) ? record.status : "invalid";
}
// 작업계획서 id는 파일 경로에 그대로 쓰이므로 경로 조작 문자를 허용하지 않는다
function isSafePlanId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\/\\\u0000-\u001f]/.test(id) && id !== "." && id !== "..";
}

function normalizeManagerName(value, label) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw publicError(400, `${label} 이름이 올바르지 않습니다.`, "INVALID_MANAGER_NAME");
  }
  const name = value.trim();
  if (name.length > 100) {
    throw publicError(400, `${label} 이름은 100자 이하로 입력해주세요.`, "INVALID_MANAGER_NAME");
  }
  return name;
}

function normalizeManagerEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeText(value, label, maxLength, { required = false } = {}) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw publicError(400, `${label} 값이 올바르지 않습니다.`, "INVALID_INPUT");
  const normalized = value.trim();
  if (required && !normalized) throw publicError(400, `${label}을(를) 입력해주세요.`, "INVALID_INPUT");
  if (normalized.length > maxLength) throw publicError(400, `${label}은(는) ${maxLength}자 이하로 입력해주세요.`, "INVALID_INPUT");
  return normalized;
}

function normalizeDate(value) {
  const date = normalizeText(value, "작업일자", 10, { required: true });
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw publicError(400, "작업일자 형식이 올바르지 않습니다.", "INVALID_DATE");
  }
  return date;
}

function normalizeTime(value, label) {
  const time = normalizeText(value, label, 5);
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw publicError(400, `${label} 형식이 올바르지 않습니다.`, "INVALID_TIME");
  }
  return time;
}

async function ghDeleteFile(env, path, sha, message) {
  const res = await externalFetch(env, "github_write", ghUrl(env, path), {
    method: "DELETE",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ message: message || `delete ${path}`, sha, branch: env.GITHUB_BRANCH || "main" }),
  });
  if (!res.ok) throw new Error(`GitHub DELETE 실패 (${path}): ${res.status} ${await res.text()}`);
  return await res.json();
}

// index.json 처럼 동시수정 충돌이 날 수 있는 파일을 안전하게 갱신 (충돌시 1회 재시도)
async function updateJsonWithRetry(env, path, mutatorFn, message, initialExisting) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = attempt === 0 && initialExisting !== undefined ? initialExisting : await ghGetJson(env, path);
    const current = existing ? existing.json : [];
    const updated = mutatorFn(current);
    try {
      await ghPutJson(env, path, updated, existing ? existing.sha : undefined, message);
      return updated;
    } catch (e) {
      if (e.status === 409 && attempt === 0) continue; // sha 충돌, 재시도
      throw e;
    }
  }
  throw new Error("동시 수정 충돌로 저장 실패, 다시 시도해주세요.");
}

// ---------- Google 로그인 검증 ----------

// Cache Google's rotating public keys, never account status or token payloads.
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
let googleKeySet;
let googleKeysRequest;
async function googleKeys(env, kid) {
  const now = Date.now();
  const fresh = googleKeySet && googleKeySet.expires > now;
  if (fresh && (googleKeySet.keys.has(kid) || now - googleKeySet.loadedAt < 60000)) return googleKeySet.keys;
  if (!googleKeysRequest) {
    googleKeysRequest = (async () => {
      const response = await externalFetch(env, "google_keys", GOOGLE_JWKS_URL);
      if (!response.ok) throw new Error("Google public key lookup failed");
      const data = await response.json();
      if (!Array.isArray(data.keys) || !data.keys.length) throw new Error("Invalid Google public keys");
      const keys = new Map();
      for (const jwk of data.keys) {
        if (jwk.kty !== "RSA" || !jwk.kid || (jwk.use && jwk.use !== "sig") || (jwk.alg && jwk.alg !== "RS256")) continue;
        keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
      }
      if (!keys.size) throw new Error("No usable Google public keys");
      const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get("Cache-Control") || "");
      const age = Number(response.headers.get("Age")) || 0;
      const ttl = Math.max(0, Math.min(86400, (maxAge ? Number(maxAge[1]) : 300) - age));
      googleKeySet = { keys, loadedAt: Date.now(), expires: Date.now() + ttl * 1000 };
      return keys;
    })().finally(() => { googleKeysRequest = null; });
  }
  return googleKeysRequest;
}
function jwtBytes(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("Invalid JWT encoding");
  return Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}
async function verifyGoogleToken(env, idToken) {
  if (typeof idToken !== "string" || !idToken || idToken.length > 16384) return null;
  const start = performance.now();
  try {
    let parts, header, data, signature;
    try {
      parts = idToken.split(".");
      if (parts.length !== 3) return null;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      header = JSON.parse(decoder.decode(jwtBytes(parts[0])));
      data = JSON.parse(decoder.decode(jwtBytes(parts[1])));
      signature = jwtBytes(parts[2]);
      const now = Date.now() / 1000;
      if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.crit) return null;
      if (!env.GOOGLE_CLIENT_ID || data.aud !== env.GOOGLE_CLIENT_ID) return null;
      if (!["accounts.google.com", "https://accounts.google.com"].includes(data.iss)) return null;
      if (typeof data.exp !== "number" || !Number.isFinite(data.exp) || data.exp <= now) return null;
      if (typeof data.iat !== "number" || !Number.isFinite(data.iat) || data.iat > now + 60) return null;
      if (data.nbf !== undefined && (typeof data.nbf !== "number" || !Number.isFinite(data.nbf) || data.nbf > now)) return null;
      if (typeof data.sub !== "string" || !data.sub || typeof data.email !== "string" || !data.email || data.email_verified !== true) return null;
    } catch { return null; }
    const key = (await googleKeys(env, header.kid)).get(header.kid);
    if (!key) return null;
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(parts[0] + "." + parts[1]));
    if (!valid) return null;
    // Preserve the existing email-keyed user records and login response contract.
    return { email: data.email.toLowerCase(), name: data.name, picture: data.picture };
  } finally {
    if (env.TIMINGS) env.TIMINGS.auth = { duration: performance.now() - start, count: 1 };
  }
}

async function requireAuth(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer /, "");
  if (!token) return null;
  return await verifyGoogleToken(env, token);
}

function safeIdPart(str) {
  return String(str).trim().replace(/[\/\\#%?"']/g, "-");
}
function safeEmailFile(email) {
  return email.replace(/[^a-zA-Z0-9]/g, "_") + ".png";
}

// ---------- 라우트 핸들러 ----------

async function handleAuth(request, env) {
  const { idToken } = await readJson(request);
  const googleUser = await verifyGoogleToken(env, idToken);
  if (!googleUser) return json({ error: "로그인 정보를 확인할 수 없습니다." }, 401, env);

  const usersFile = await ghGetJson(env, "users.json");
  const users = usersFile ? usersFile.json : {};
  const record = users[googleUser.email];
  const accountStatus = accountStatusOf(record);

  if (accountStatus === "not_registered") {
    return json({ status: "not_registered", email: googleUser.email, name: googleUser.name }, 200, env);
  }
  if (accountStatus === "pending") {
    return json({ status: "pending", email: googleUser.email }, 200, env);
  }
  if (accountStatus === "rejected") {
    return json({ status: "rejected", email: googleUser.email }, 200, env);
  }
  if (accountStatus === "suspended") {
    return json({ status: "suspended", email: googleUser.email }, 200, env);
  }
  if (accountStatus !== "approved") {
    return json({ error: "계정 상태를 확인할 수 없습니다. 관리자에게 문의해주세요.", status: "invalid" }, 403, env);
  }
  return json(
    {
      status: "approved",
      user: {
        email: googleUser.email,
        ...record,
        org: effectiveOrg(env, googleUser.email, record),
        tier: tierOf(env, googleUser.email, record),
        isAdmin: isAdminEmail(env, googleUser.email),
      },
    },
    200,
    env
  );
}

async function handleRegister(request, env) {
  const body = await readJson(request, 2_100_000);
  const googleUser = await verifyGoogleToken(env, body.idToken);
  if (!googleUser) return json({ error: "로그인 정보를 확인할 수 없습니다." }, 401, env);

  const { imageBase64 } = body;
  const companyName = normalizeText(body.company, "업체명", 100, { required: true });
  const adminName = normalizeText(body.adminName, "관리자명", 100, { required: true });
  const phone = normalizeText(body.phone, "연락처", 30, { required: true });
  if (isHyundaiLookalike(companyName)) {
    return json({ error: `현대건설 소속은 드롭다운에서 "${HYUNDAI_COMPANY}"를 선택해주세요.` }, 400, env);
  }
  const org = orgFromCompany(companyName);
  const usersFile = await ghGetJson(env, "users.json");
  if (usersFile && usersFile.json[googleUser.email]) {
    return json({ error: "이미 가입 신청 또는 등록된 계정입니다.", code: "ACCOUNT_ALREADY_EXISTS" }, 409, env);
  }
  const signatureBase64Content = imageBase64 ? signatureBase64(imageBase64) : null;
  const signatureUrl = signatureBase64Content ? `signatures/${safeEmailFile(googleUser.email)}` : null;

  // Validate and upload the optional signature before creating the account. This keeps
  // registration retryable if the image write fails and avoids a second users.json update.
  if (signatureBase64Content) {
    const existing = await ghGetFile(env, signatureUrl);
    await ghPutBinaryBase64(env, signatureUrl, signatureBase64Content, existing ? existing.sha : undefined, `가입 서명 등록: ${googleUser.email}`);
  }

  await updateJsonWithRetry(
    env,
    "users.json",
    (users) => {
      if (users[googleUser.email]) {
        throw publicError(409, "이미 가입 신청 또는 등록된 계정입니다.", "ACCOUNT_ALREADY_EXISTS");
      }
      users[googleUser.email] = {
        name: adminName,
        company: companyName,
        org,
        phone,
        status: "pending",
        signatureUrl,
        createdAt: new Date().toISOString(),
      };
      return users;
    },
    `가입신청: ${googleUser.email}`,
    usersFile
  );

  return json({ ok: true }, 200, env);
}

async function handleCompanies(request, env) {
  const usersFile = await ghGetJson(env, "users.json");
  const users = usersFile ? usersFile.json : {};
  const set = new Set();
  Object.values(users).forEach((u) => {
    if (u.status !== "approved" || !u.company) return;
    if (recordOrg(u) !== "vendor") return; // 현대건설(주) 및 현대건설 단계 계정 제외
    if (isHyundaiLookalike(u.company)) return; // "현대건설", "(주)현대건설" 같은 비슷한 이름 제외
    set.add(u.company);
  });
  return json({ companies: Array.from(set).sort() }, 200, env);
}

async function handleManagers(request, env, url, currentUser, usersFile) {
  const org = url.searchParams.get("org");
  const company = url.searchParams.get("company");
  const users = usersFile ? usersFile.json : {};
  const list = Object.entries(users)
    .filter(([email, u]) => u.status === "approved" && effectiveOrg(env, email, u) === org && (!company || u.company === company))
    // 연락처 원문은 ADMIN 사용자 관리 기능에서만 제공한다. 기존 필드는 유지해
    // 오래된 클라이언트도 응답을 안전하게 처리할 수 있도록 빈 문자열로 마스킹한다.
    .map(([email, u]) => ({
      email: currentUser.isAdmin ? email : "",
      name: u.name,
      company: u.company,
      phone: currentUser.isAdmin ? u.phone || "" : "",
    }));
  return json({ managers: list }, 200, env);
}

function auditLog(action, currentUser, target, details = {}) {
  console.info("AUDIT", {
    action,
    actor: currentUser.email,
    actorTier: currentUser.tier,
    target,
    ...details,
  });
}

async function handlePendingUsers(request, env, usersFile) {
  const users = usersFile ? usersFile.json : {};
  const list = Object.entries(users)
    .filter(([, u]) => u.status === "pending")
    .map(([email, u]) => ({ email, ...u }));
  return json({ pending: list }, 200, env);
}

async function handleApproveUser(request, env, approverEmail, usersFile) {
  const { email, approve } = (await readJson(request)) || {};
  if (typeof email !== "string" || !email.trim()) {
    throw publicError(400, "대상 사용자가 없습니다.", "INVALID_EMAIL");
  }
  if (typeof approve !== "boolean") {
    throw publicError(400, "승인 여부는 true 또는 false로 지정해주세요.", "INVALID_APPROVAL");
  }
  if (isAdminEmail(env, email)) {
    throw publicError(403, "ADMIN 계정은 변경할 수 없습니다.", "ADMIN_ACCOUNT_PROTECTED");
  }
  await updateJsonWithRetry(
    env,
    "users.json",
    (users) => {
      if (!Object.hasOwn(users, email) || !users[email]) {
        throw publicError(404, "사용자를 찾을 수 없습니다.", "USER_NOT_FOUND");
      }
      // 재시도에서도 현재 상태를 확인해 정지 해제나 기존 계정 변경에 악용되지 않도록 한다.
      if (accountStatusOf(users[email]) !== "pending") {
        throw publicError(409, "가입 승인 대기중인 사용자만 승인 또는 반려할 수 있습니다.", "INVALID_ACCOUNT_STATUS");
      }
      users[email].status = approve ? "approved" : "rejected";
      users[email].approvedBy = approverEmail;
      users[email].approvedAt = new Date().toISOString();
      return users;
    },
    `audit user.registration.${approve ? "approve" : "reject"} target=${email} actor=${approverEmail}`,
    usersFile
  );
  console.info("AUDIT", { action: approve ? "user.registration.approve" : "user.registration.reject", actor: approverEmail, target: email });
  return json({ ok: true }, 200, env);
}

async function handleSignatureUpload(request, env, userEmail, usersFile) {
  const { imageBase64 } = await readJson(request, 2_100_000);
  const base64 = signatureBase64(imageBase64);
  const path = `signatures/${safeEmailFile(userEmail)}`;
  const existing = await ghGetFile(env, path);
  await ghPutBinaryBase64(env, path, base64, existing ? existing.sha : undefined, `서명 등록: ${userEmail}`);

  await updateJsonWithRetry(
    env,
    "users.json",
    (users) => {
      if (users[userEmail]) users[userEmail].signatureUrl = path;
      return users;
    },
    `서명 경로 업데이트: ${userEmail}`,
    usersFile
  );
  return json({ ok: true, path }, 200, env);
}

async function getSignatureDataUrl(env, users, email) {
  const rec = users[email];
  if (!rec || !rec.signatureUrl) return null;
  const b64 = await ghGetBinaryBase64(env, rec.signatureUrl);
  return b64 ? `data:image/png;base64,${b64}` : null;
}

async function handleGetMySignature(env, currentUser, usersFile) {
  const dataUrl = await getSignatureDataUrl(env, usersFile ? usersFile.json : {}, currentUser.email);
  return json({ dataUrl }, 200, env);
}

// ---------- 관리자(ADMIN) 전용: 사용자 관리 ----------

async function handleAdminListUsers(env, usersFile) {
  const users = usersFile ? usersFile.json : {};
  const list = Object.entries(users).map(([email, u]) => ({
    email,
    name: u.name,
    company: u.company,
    org: effectiveOrg(env, email, u),
    tier: tierOf(env, email, u),
    phone: u.phone,
    status: u.status,
    hasSignature: !!u.signatureUrl,
    createdAt: u.createdAt,
    isAdmin: isAdminEmail(env, email),
  }));
  return json({ users: list }, 200, env);
}

async function handleAdminSignature(env, url, currentUser, usersFile) {
  const email = url.searchParams.get("email");
  const dataUrl = await getSignatureDataUrl(env, usersFile ? usersFile.json : {}, email);
  auditLog("user.signature.read", currentUser, email);
  return json({ dataUrl }, 200, env);
}

async function handleAdminUpdateUser(request, env, currentUser, usersFile) {
  const { email, name, phone } = await readJson(request);
  if (!email) return json({ error: "대상 사용자가 없습니다." }, 400, env);
  if (name !== undefined && !String(name).trim()) return json({ error: "이름을 입력해주세요." }, 400, env);
  await updateJsonWithRetry(
    env,
    "users.json",
    (users) => {
      if (!users[email]) throw publicError(404, "사용자를 찾을 수 없습니다.", "USER_NOT_FOUND");
      if (name !== undefined) users[email].name = String(name).trim();
      if (phone !== undefined) users[email].phone = String(phone).trim();
      return users;
    },
    `audit user.update target=${email} actor=${currentUser.email}`,
    usersFile
  );
  auditLog("user.update", currentUser, email, { fields: [name !== undefined ? "name" : null, phone !== undefined ? "phone" : null].filter(Boolean) });
  return json({ ok: true }, 200, env);
}

// 사용자 이름 일괄 변경: 이메일로 연결된 기존 작업계획서의 역할별 표시 이름도 함께 변경한다.
// GitHub API 호출 제한을 피하기 위해 목록을 15건씩 훑고, 마지막 배치에서 users.json을 변경한다.
async function handleAdminRenameUser(request, env, currentUser, usersFile) {
  const body = await readJson(request);
  const email = String(body.email || "").trim();
  const name = String(body.name || "").trim();
  const cursor = Number.isInteger(body.cursor) && body.cursor >= 0 ? body.cursor : 0;
  if (!email) return json({ error: "대상 사용자가 없습니다." }, 400, env);
  if (!name) return json({ error: "이름을 입력해주세요." }, 400, env);

  const users = usersFile ? usersFile.json : {};
  if (!users[email]) return json({ error: "사용자를 찾을 수 없습니다." }, 404, env);

  const indexFile = await ghGetJson(env, "data/index.json");
  const list = indexFile ? indexFile.json : [];
  const batch = list.slice(cursor, cursor + 15);
  const summaries = {};
  let plansUpdated = 0;

  for (const item of batch) {
    const f = await ghGetJson(env, `data/plans/${item.id}.json`);
    if (!f) continue;
    const plan = f.json;
    let changed = false;
    if (plan.writerEmail === email && plan.writerName !== name) {
      plan.writerName = name;
      changed = true;
    }
    if (plan.vendorManagerEmail === email && plan.vendorManagerName !== name) {
      plan.vendorManagerName = name;
      changed = true;
    }
    if (plan.hyundaiManagerEmail === email && plan.hyundaiManagerName !== name) {
      plan.hyundaiManagerName = name;
      changed = true;
    }
    if (plan.approval && plan.approval.approverEmail === email && plan.approval.approverName !== name) {
      plan.approval.approverName = name;
      changed = true;
    }
    if (plan.executionReview && plan.executionReview.reviewerEmail === email && plan.executionReview.reviewerName !== name) {
      plan.executionReview.reviewerName = name;
      changed = true;
    }
    if (plan.safetyApproval && plan.safetyApproval.approverEmail === email && plan.safetyApproval.approverName !== name) {
      plan.safetyApproval.approverName = name;
      changed = true;
    }
    if (!changed) continue;

    await ghPutJson(env, `data/plans/${item.id}.json`, plan, f.sha, `사용자 이름 변경: ${item.id}`);
    summaries[item.id] = {
      writerName: plan.writerName || "",
      vendorManagerName: plan.vendorManagerName || "",
      hyundaiManagerName: plan.hyundaiManagerName || "",
      approverName: plan.status === "approved" && plan.approval ? plan.approval.approverName || "" : "",
      executionReviewerName: plan.executionReview ? plan.executionReview.reviewerName || "" : "",
      safetyApproverName: plan.safetyApproval ? plan.safetyApproval.approverName || "" : "",
    };
    plansUpdated++;
  }

  if (Object.keys(summaries).length) {
    await updateJsonWithRetry(
      env,
      "data/index.json",
      (items) => {
        items.forEach((item) => {
          if (summaries[item.id]) Object.assign(item, summaries[item.id]);
        });
        return items;
      },
      `목록 사용자 이름 변경: ${email}`
    );
  }

  const nextCursor = cursor + batch.length;
  const remaining = Math.max(0, list.length - nextCursor);
  let userUpdated = false;
  if (remaining === 0 && users[email].name !== name) {
    await updateJsonWithRetry(
      env,
      "users.json",
      (currentUsers) => {
        if (!currentUsers[email]) throw publicError(404, "사용자를 찾을 수 없습니다.", "USER_NOT_FOUND");
        currentUsers[email].name = name;
        return currentUsers;
      },
      `audit user.rename target=${email} actor=${currentUser.email}`,
      usersFile
    );
    userUpdated = true;
  }

  auditLog("user.rename", currentUser, email, { plansUpdated, remaining, userUpdated });

  return json({ ok: true, plansUpdated, remaining, nextCursor, userUpdated }, 200, env);
}

async function handleAdminSetStatus(request, env, currentUser, usersFile) {
  const { email, status } = await readJson(request);
  if (!["approved", "suspended"].includes(status)) return json({ error: "잘못된 상태값입니다." }, 400, env);
  if (isAdminEmail(env, email)) return json({ error: "ADMIN 계정은 변경할 수 없습니다." }, 403, env);
  await updateJsonWithRetry(
    env,
    "users.json",
    (users) => {
      if (!users[email]) throw publicError(404, "사용자를 찾을 수 없습니다.", "USER_NOT_FOUND");
      if (!["approved", "suspended"].includes(users[email].status)) {
        throw publicError(400, "승인된 사용자만 이용 정지/해제할 수 있습니다.", "INVALID_ACCOUNT_STATUS");
      }
      users[email].status = status;
      return users;
    },
    `audit user.status.${status} target=${email} actor=${currentUser.email}`,
    usersFile
  );
  auditLog(`user.status.${status}`, currentUser, email);
  return json({ ok: true }, 200, env);
}

async function handleAdminDeleteUser(request, env, currentUser, usersFile) {
  const { email } = await readJson(request);
  if (isAdminEmail(env, email)) return json({ error: "ADMIN 계정은 삭제할 수 없습니다." }, 403, env);
  const rec = usersFile && usersFile.json[email];
  if (!rec) return json({ error: "사용자를 찾을 수 없습니다." }, 404, env);
  if (rec.signatureUrl) {
    try {
      const sf = await ghGetFile(env, rec.signatureUrl);
      if (sf) await ghDeleteFile(env, rec.signatureUrl, sf.sha, `사용자 삭제로 서명 제거: ${email}`);
    } catch (e) {}
  }
  await updateJsonWithRetry(
    env,
    "users.json",
    (users) => {
      delete users[email];
      return users;
    },
    `audit user.delete target=${email} actor=${currentUser.email}`,
    usersFile
  );
  auditLog("user.delete", currentUser, email);
  return json({ ok: true }, 200, env);
}

// 회사명 일괄 변경: 같은 업체 소속 전원 + 기존 작업계획서의 업체명
// (무료 플랜의 요청당 호출 제한 때문에 작업계획서는 한 번에 15건씩 처리하고 remaining을 돌려줌 → 화면에서 반복 호출)
async function handleAdminRenameCompany(request, env, currentUser, usersFile) {
  const body = await readJson(request);
  const from = String(body.from || "").trim();
  const to = String(body.to || "").trim();
  if (!from || !to) return json({ error: "회사명을 입력해주세요." }, 400, env);
  if (from === to) return json({ error: "변경할 회사명이 기존과 같습니다." }, 400, env);
  if (isHyundaiLookalike(to)) {
    return json({ error: `현대건설 소속 회사명은 "${HYUNDAI_COMPANY}"로만 사용할 수 있습니다.` }, 400, env);
  }

  // 1) 작업계획서(및 목록 요약)의 company만 먼저 바꾼다.
  //    plan id·작업일자·작성자·승인상태·승인정보 등은 절대 건드리지 않는다.
  //    이미 "to"로 바뀐 건은 "from" 필터에 더 이상 걸리지 않으므로, 같은 요청을 여러 번
  //    호출해도(=idempotent) 중복 처리나 데이터 훼손 없이 남은 건만 이어서 처리된다.
  const indexFile = await ghGetJson(env, "data/index.json");
  const list = indexFile ? indexFile.json : [];
  const targets = list.filter((p) => p.company === from);
  const batch = targets.slice(0, 15);
  for (const t of batch) {
    const f = await ghGetJson(env, `data/plans/${t.id}.json`);
    if (f && f.json.company === from) {
      f.json.company = to;
      await ghPutJson(env, `data/plans/${t.id}.json`, f.json, f.sha, `업체명 변경: ${t.id}`);
    }
  }
  if (batch.length) {
    const ids = new Set(batch.map((t) => t.id));
    await updateJsonWithRetry(
      env,
      "data/index.json",
      (l) => {
        l.forEach((p) => {
          if (ids.has(p.id)) p.company = to;
        });
        return l;
      },
      `목록 업체명 변경: ${from} → ${to}`
    );
  }
  const remaining = targets.length - batch.length;

  // 2) 작업계획서 쪽 변경이 이번 호출로 전부 끝났을 때(remaining === 0)만 users.json을 바꾼다.
  //    도중에 실패해도 "사용자는 새 이름인데 계획서는 옛 이름"인 어중간한 상태가 남지 않는다.
  //    이미 users.json이 바뀐 뒤 다시 호출돼도(예: 재시도) from과 일치하는 사용자가 없으면
  //    아무 변화 없이 안전하게 끝난다.
  let usersUpdated = 0;
  if (remaining === 0) {
    const users = usersFile ? usersFile.json : {};
    if (Object.values(users).some((u) => u.company === from)) {
      await updateJsonWithRetry(
        env,
        "users.json",
        (us) => {
          usersUpdated = 0;
          Object.values(us).forEach((u) => {
            if (u.company === from) {
              u.company = to;
              u.org = orgFromCompany(to);
              usersUpdated++;
            }
          });
          return us;
        },
        `audit company.rename target=${from} actor=${currentUser.email}`,
        usersFile
      );
    }
  }

  auditLog("company.rename", currentUser, from, { to, plansUpdated: batch.length, usersUpdated, remaining });

  return json({ ok: true, usersUpdated, plansUpdated: batch.length, remaining }, 200, env);
}

async function handleListPlans(request, env, url, currentUser) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const scope = url.searchParams.get("scope"); // "all" 이면 소속과 무관하게 전체 조회
  const companyParam = url.searchParams.get("company"); // 특정 업체를 콕 집어 조회 (참고용)
  const indexFile = await ghGetJson(env, "data/index.json");
  let list = indexFile ? indexFile.json : [];

  if (from) list = list.filter((p) => p.workDate >= from);
  if (to) list = list.filter((p) => p.workDate <= to);

  // 조회 범위 결정 (다른 업체가 어떻게 작성했는지 참고할 수 있도록 조회 전용으로 열어줌;
  // 수정·삭제·결재 등 실제 조작 권한은 각 액션별 핸들러에서 별도로 그대로 검사한다)
  // 1) scope=all: 누구든 전체 조회
  // 2) company=업체명: 그 업체 것만 콕 집어 조회
  // 3) 파라미터가 없으면 기존 기본값: 협력업체(비 ADMIN)는 자기 회사만, 현대건설/ADMIN은 전체
  if (scope === "all") {
    // 필터 없음 (전체)
  } else if (companyParam) {
    list = list.filter((p) => p.company === companyParam);
  } else if (currentUser.org === "vendor" && !currentUser.isAdmin) {
    list = list.filter((p) => p.company === currentUser.company);
  }
  list.sort((a, b) => (a.workDate < b.workDate ? 1 : -1));
  return json({ plans: list }, 200, env);
}

function assertCanReadPlanDetail(currentUser, plan) {
  const isWriter = plan.writerEmail && plan.writerEmail === currentUser.email;
  if (currentUser.org !== "hyundai" && !currentUser.isAdmin && plan.company !== currentUser.company && !isWriter) {
    throw publicError(403, "다른 업체의 작업계획서 상세는 조회할 수 없습니다.", "PLAN_DETAIL_FORBIDDEN");
  }
}

async function handleGetPlan(request, env, id, currentUser) {
  const file = await ghGetJson(env, `data/plans/${id}.json`);
  if (!file) return json({ error: "작업계획서를 찾을 수 없습니다." }, 404, env);
  assertCanReadPlanDetail(currentUser, file.json);
  return json({ plan: file.json }, 200, env);
}

function signatureDataUrl(base64) {
  if (!base64) return null;
  const mime = base64.startsWith("/9j/") ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${base64}`;
}

async function handleGetPlanSignatures(env, id, currentUser, usersFile) {
  const file = await ghGetJson(env, `data/plans/${id}.json`);
  if (!file) return json({ error: "작업계획서를 찾을 수 없습니다." }, 404, env);
  const plan = file.json;
  assertCanReadPlanDetail(currentUser, plan);
  const vendorPath = usersFile && usersFile.json[plan.writerEmail] && usersFile.json[plan.writerEmail].signatureUrl;
  const executionPath = plan.executionReview && plan.executionReview.signatureUrl;
  const safetyApproval = plan.safetyApproval || (plan.status === "approved" ? plan.approval : null);
  const safetyPath = safetyApproval && safetyApproval.signatureUrl;
  const [vendor, execution, safety] = await Promise.all([
    vendorPath ? ghGetBinaryBase64(env, vendorPath) : null,
    executionPath ? ghGetBinaryBase64(env, executionPath) : null,
    safetyPath ? ghGetBinaryBase64(env, safetyPath) : null,
  ]);
  auditLog("plan.signatures.read", currentUser, id);
  return json({
    signatures: {
      vendor: signatureDataUrl(vendor),
      execution: signatureDataUrl(execution),
      safety: signatureDataUrl(safety),
    },
  }, 200, env);
}

function makePlanId(workDate, company, workType) {
  return `${workDate}_${safeIdPart(company)}_${safeIdPart(workType)}`;
}

async function handleSavePlan(request, env, currentUser) {
  const body = await readJson(request, 128 * 1024);
  const workDate = normalizeDate(body.workDate);
  const company = normalizeText(body.company, "업체명", 100, { required: true });
  const workType = normalizeText(body.workType, "작업구분", 50, { required: true });
  // 협력업체는 자기 업체 명의의 작업계획서만 작성·수정할 수 있고, 현대건설 단계는 모든 업체 건을 작성·수정할 수 있다
  const isHyundai = currentUser.org === "hyundai";
  if (!isHyundai && company !== currentUser.company) {
    return json({ error: "자기 업체의 작업계획서만 작성·수정할 수 있습니다." }, 403, env);
  }
  const id = body.id || makePlanId(workDate, company, workType);
  if (!isSafePlanId(id)) return json({ error: "잘못된 작업계획서 번호입니다." }, 400, env);
  const existingFile = await ghGetJson(env, `data/plans/${id}.json`);
  if (existingFile) {
    if (!isHyundai && existingFile.json.company !== currentUser.company) {
      return json({ error: "자기 업체의 작업계획서만 작성·수정할 수 있습니다." }, 403, env);
    }
    if (existingFile.json.status === "approved") {
      return json({ error: "승인완료된 작업계획서는 수정할 수 없습니다." }, 400, env);
    }
  }
  const now = new Date().toISOString();

  // 서버가 관리하는 값(상태, 승인 정보, 작성자, 시각 등)은 클라이언트가 보낸 값을 무시한다
  const safeBody = {
    workDate,
    workType,
    company,
    vendorManagerEmail: normalizeManagerEmail(body.vendorManagerEmail),
    vendorManagerName: normalizeManagerName(body.vendorManagerName, "협력업체 상주관리자"),
  };
  const optionalFields = {
    workTimeStart: () => normalizeTime(body.workTimeStart, "작업 시작시간"),
    workTimeEnd: () => normalizeTime(body.workTimeEnd, "작업 종료시간"),
    workLocation: () => normalizeText(body.workLocation, "작업장소/내용", 3000),
    workforceEquipment: () => normalizeText(body.workforceEquipment, "작업 인원/장비", 3000),
    hazards: () => normalizeText(body.hazards, "위험요인", 5000),
    mitigations: () => normalizeText(body.mitigations, "저감대책", 5000),
  };
  Object.entries(optionalFields).forEach(([key, normalize]) => {
    if (Object.hasOwn(body, key)) safeBody[key] = normalize();
  });

  const plan = {
    ...(existingFile ? existingFile.json : {}),
    ...safeBody,
    id,
    status: existingFile ? existingFile.json.status : "draft",
    writerEmail: existingFile ? existingFile.json.writerEmail : currentUser.email,
    writerName: existingFile ? existingFile.json.writerName : currentUser.name,
    updatedAt: now,
    createdAt: existingFile ? existingFile.json.createdAt : now,
  };

  await ghPutJson(env, `data/plans/${id}.json`, plan, existingFile ? existingFile.sha : undefined, `작업계획서 저장: ${id}`);

  await updateJsonWithRetry(
    env,
    "data/index.json",
    (list) => {
      const idx = list.findIndex((p) => p.id === id);
      const summary = {
        id,
        workDate: plan.workDate,
        workTimeStart: plan.workTimeStart || "",
        workTimeEnd: plan.workTimeEnd || "",
        workType: plan.workType,
        company: plan.company,
        status: plan.status,
        vendorManagerName: plan.vendorManagerName || "",
        hyundaiManagerName: plan.hyundaiManagerName || "",
        writerName: plan.writerName || "",
        approverName: plan.status === "approved" && plan.approval ? plan.approval.approverName || "" : "",
        executionReviewerName: plan.executionReview ? plan.executionReview.reviewerName || "" : "",
        safetyApproverName: plan.safetyApproval ? plan.safetyApproval.approverName || "" : "",
        updatedAt: now,
      };
      if (idx >= 0) list[idx] = summary;
      else list.push(summary);
      return list;
    },
    `목록 갱신: ${id}`
  );

  return json({ ok: true, id }, 200, env);
}

async function handleSubmitPlan(request, env, id, currentUser) {
  const file = await ghGetJson(env, `data/plans/${id}.json`);
  if (!file) return json({ error: "작업계획서를 찾을 수 없습니다." }, 404, env);
  const plan0 = file.json;
  // 협력업체는 같은 업체 건만, 현대건설 단계는 모든 업체 건 승인요청 가능
  if (currentUser.org !== "hyundai" && plan0.company !== currentUser.company) {
    return json({ error: "자기 업체의 작업계획서만 승인요청할 수 있습니다." }, 403, env);
  }
  if (plan0.status !== "draft" && plan0.status !== "pending") {
    return json({ error: "승인완료된 작업계획서는 승인요청할 수 없습니다." }, 400, env);
  }
  const vendorManagerName = normalizeManagerName(plan0.vendorManagerName, "협력업체 상주관리자");
  if (!vendorManagerName) {
    return json({ error: "협력업체 상주관리자를 선택하거나 직접 입력해주세요." }, 400, env);
  }
  await updatePlanStatus(env, id, "pending", (plan) => {
    plan.vendorManagerName = vendorManagerName;
    plan.vendorManagerEmail = normalizeManagerEmail(plan.vendorManagerEmail);
    plan.submittedAt = new Date().toISOString();
    delete plan.executionReview;
    delete plan.safetyApproval;
    delete plan.rejectedAt;
    delete plan.rejectedBy;
    delete plan.rejectedByName;
    delete plan.rejectedStage;
    delete plan.rejectReason;
  }, currentUser, "plan.submit", file);
  return json({ ok: true }, 200, env);
}

function signatureBase64(dataUrl) {
  if (typeof dataUrl !== "string" || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
    throw publicError(400, "PNG 또는 JPG 형식의 서명 이미지를 등록해주세요.", "INVALID_SIGNATURE");
  }
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if (base64.length > 2_000_000) {
    throw publicError(400, "서명 이미지는 1.5MB 이하로 등록해주세요.", "SIGNATURE_TOO_LARGE");
  }
  return base64;
}

async function requireHyundaiSignature(env, currentUser, actionLabel, usersFile) {
  if (currentUser.org !== "hyundai") {
    throw publicError(403, `현대건설 소속만 ${actionLabel}할 수 있습니다.`, "FORBIDDEN");
  }
  const users = usersFile ? usersFile.json : {};
  const signatureUrl = (users[currentUser.email] && users[currentUser.email].signatureUrl) || null;
  if (!signatureUrl) {
    throw publicError(400, "먼저 마이페이지에서 서명을 등록해주세요.", "SIGNATURE_REQUIRED");
  }
  return signatureUrl;
}

function assertPlanInApproval(plan, actionLabel) {
  if (!["pending", "approving"].includes(plan.status)) {
    throw publicError(400, `승인요청된 작업계획서만 ${actionLabel}할 수 있습니다.`, "INVALID_PLAN_STATUS");
  }
}

async function handleExecutionReview(request, env, id, currentUser, usersFile) {
  const signatureUrl = await requireHyundaiSignature(env, currentUser, "수행팀 검토", usersFile);
  const planFile = await ghGetJson(env, `data/plans/${id}.json`);
  if (!planFile) return json({ error: "작업계획서를 찾을 수 없습니다." }, 404, env);
  assertPlanInApproval(planFile.json, "수행팀 검토");
  if (planFile.json.executionReview) return json({ error: "이미 수행팀 검토가 완료되었습니다." }, 400, env);
  const body = await readJson(request, 64 * 1024, { allowEmpty: true });
  const hyundaiManagerName = normalizeManagerName(body.hyundaiManagerName, "현대건설 상주관리자");
  await updatePlanStatus(env, id, planFile.json.safetyApproval ? "approved" : "approving", (plan) => {
    if (hyundaiManagerName) {
      plan.hyundaiManagerEmail = normalizeManagerEmail(body.hyundaiManagerEmail);
      plan.hyundaiManagerName = hyundaiManagerName;
    }
    plan.executionReview = {
      reviewerEmail: currentUser.email,
      reviewerName: currentUser.name,
      signatureUrl,
      reviewedAt: new Date().toISOString(),
    };
    if (plan.safetyApproval) plan.approval = { ...plan.safetyApproval };
  }, currentUser, "plan.execution_review");
  return json({ ok: true }, 200, env);
}

async function handleSafetyApprove(request, env, id, currentUser, usersFile, options = {}) {
  const signatureUrl = await requireHyundaiSignature(env, currentUser, "안전팀 승인", usersFile);
  const planFile = await ghGetJson(env, `data/plans/${id}.json`);
  if (!planFile) return json({ error: "작업계획서를 찾을 수 없습니다." }, 404, env);
  assertPlanInApproval(planFile.json, "안전팀 승인");
  if (planFile.json.safetyApproval) return json({ error: "이미 안전팀 승인이 완료되었습니다." }, 400, env);
  const body = await readJson(request, 64 * 1024, { allowEmpty: true });
  const hyundaiManagerName = normalizeManagerName(body.hyundaiManagerName, "현대건설 상주관리자");
  if (options.requireManager && !hyundaiManagerName) {
    return json({ error: "현대건설 상주관리자를 선택하거나 직접 입력해주세요." }, 400, env);
  }
  await updatePlanStatus(env, id, planFile.json.executionReview ? "approved" : "pending", (plan) => {
    if (hyundaiManagerName) {
      plan.hyundaiManagerEmail = normalizeManagerEmail(body.hyundaiManagerEmail);
      plan.hyundaiManagerName = hyundaiManagerName;
    }
    plan.safetyApproval = {
      approverEmail: currentUser.email,
      approverName: currentUser.name,
      signatureUrl,
      approvedAt: new Date().toISOString(),
    };
    // 최종 승인 시 기존 단일 승인 필드도 유지해 기존 API와 다운로드 양식의 호환성을 보존한다.
    if (plan.executionReview) plan.approval = { ...plan.safetyApproval };
  }, currentUser, "plan.safety_approve");
  return json({ ok: true }, 200, env);
}

async function handleApprovePlan(request, env, id, currentUser, usersFile) {
  return handleSafetyApprove(request, env, id, currentUser, usersFile, { requireManager: true });
}

async function handleRejectPlan(request, env, id, currentUser) {
  if (currentUser.org !== "hyundai") {
    return json({ error: "현대건설 소속만 반려할 수 있습니다." }, 403, env);
  }
  const planFile = await ghGetJson(env, `data/plans/${id}.json`);
  if (!planFile) return json({ error: "작업계획서를 찾을 수 없습니다." }, 404, env);
  if (!["pending", "approving"].includes(planFile.json.status)) {
    return json({ error: "승인요청된 작업계획서만 반려할 수 있습니다." }, 400, env);
  }
  const { reason, stage: requestedStage } = await readJson(request);
  const normalizedReason = normalizeText(reason, "반려 사유", 2000);
  // 기존 클라이언트의 단계 없는 /reject 요청은 종전 승인 단계인 안전팀 반려로 처리한다.
  const stage = requestedStage || "safety";
  if (!["execution", "safety"].includes(stage)) return json({ error: "잘못된 반려 단계입니다." }, 400, env);
  await updatePlanStatus(env, id, "draft", (plan) => {
    plan.rejectReason = normalizedReason;
    plan.rejectedAt = new Date().toISOString();
    plan.rejectedBy = currentUser.email;
    plan.rejectedByName = currentUser.name;
    plan.rejectedStage = stage;
    delete plan.executionReview;
    delete plan.safetyApproval;
    delete plan.approval;
  }, currentUser, "plan.reject");
  return json({ ok: true }, 200, env);
}

async function handleChangeHyundaiManager(request, env, id, currentUser) {
  if (currentUser.org !== "hyundai") {
    return json({ error: "현대건설 소속만 상주관리자를 변경할 수 있습니다." }, 403, env);
  }
  const planFile = await ghGetJson(env, `data/plans/${id}.json`);
  if (!planFile) return json({ error: "작업계획서를 찾을 수 없습니다." }, 404, env);
  if (!["pending", "approving", "approved"].includes(planFile.json.status)) {
    return json({ error: "승인요청 이후에만 상주관리자를 지정하거나 변경할 수 있습니다." }, 400, env);
  }
  const body = await readJson(request, 64 * 1024, { allowEmpty: true });
  const hyundaiManagerName = normalizeManagerName(body.hyundaiManagerName, "현대건설 상주관리자");
  if (!hyundaiManagerName) {
    return json({ error: "현대건설 상주관리자를 선택하거나 직접 입력해주세요." }, 400, env);
  }
  const now = new Date().toISOString();
  const plan = {
    ...planFile.json,
    hyundaiManagerEmail: normalizeManagerEmail(body.hyundaiManagerEmail),
    hyundaiManagerName,
    updatedAt: now,
  };
  await ghPutJson(env, `data/plans/${id}.json`, plan, planFile.sha, `audit plan.manager_change target=${id} actor=${currentUser.email}`);
  await updateJsonWithRetry(
    env,
    "data/index.json",
    (list) => {
      const idx = list.findIndex((p) => p.id === id);
      if (idx >= 0) {
        list[idx].hyundaiManagerName = hyundaiManagerName;
        list[idx].updatedAt = now;
      }
      return list;
    },
    `목록 현대건설 상주관리자 변경: ${id}`
  );
  auditLog("plan.manager_change", currentUser, id);
  return json({ ok: true }, 200, env);
}

async function updatePlanStatus(env, id, status, mutatorFn, currentUser, action, initialFile) {
  const file = initialFile || await ghGetJson(env, `data/plans/${id}.json`);
  if (!file) throw publicError(404, "작업계획서를 찾을 수 없습니다.", "PLAN_NOT_FOUND");
  const plan = file.json;
  plan.status = status;
  plan.updatedAt = new Date().toISOString();
  if (mutatorFn) mutatorFn(plan);
  await ghPutJson(env, `data/plans/${id}.json`, plan, file.sha, `audit ${action} target=${id} actor=${currentUser.email} status=${status}`);

  await updateJsonWithRetry(
    env,
    "data/index.json",
    (list) => {
      const idx = list.findIndex((p) => p.id === id);
      if (idx >= 0) {
        list[idx].status = status;
        list[idx].updatedAt = plan.updatedAt;
        list[idx].hyundaiManagerName = plan.hyundaiManagerName || "";
        list[idx].writerName = plan.writerName || "";
        list[idx].approverName = plan.status === "approved" && plan.approval ? plan.approval.approverName || "" : "";
        list[idx].executionReviewerName = plan.executionReview ? plan.executionReview.reviewerName || "" : "";
        list[idx].safetyApproverName = plan.safetyApproval ? plan.safetyApproval.approverName || "" : "";
      }
      return list;
    },
    `목록 상태 갱신: ${id}`
  );
  auditLog(action, currentUser, id, { status });
}

async function handleDeletePlan(request, env, id, currentUser) {
  const file = await ghGetJson(env, `data/plans/${id}.json`);
  if (!file) return json({ error: "작업계획서를 찾을 수 없습니다." }, 404, env);
  const plan = file.json;
  // 삭제 정책: 승인완료는 삭제 불가
  //  - 작성중(draft): 현대건설 소속 또는 작성자 본인
  //  - 검토중(pending): 현대건설 소속만 (작성자는 불가)
  const isHyundai = currentUser.org === "hyundai";
  const isWriter = currentUser.email === plan.writerEmail;
  if (plan.status === "draft") {
    if (!(isHyundai || isWriter)) return json({ error: "삭제 권한이 없습니다." }, 403, env);
  } else if (["pending", "approving"].includes(plan.status)) {
    if (!isHyundai) return json({ error: "검토중인 작업계획서는 현대건설만 삭제할 수 있습니다." }, 403, env);
  } else {
    return json({ error: "작성중 또는 검토중 상태의 작업계획서만 삭제할 수 있습니다." }, 400, env);
  }
  await ghDeleteFile(env, `data/plans/${id}.json`, file.sha, `audit plan.delete target=${id} actor=${currentUser.email}`);
  await updateJsonWithRetry(
    env,
    "data/index.json",
    (list) => list.filter((p) => p.id !== id),
    `목록에서 삭제: ${id}`
  );
  auditLog("plan.delete", currentUser, id, { status: plan.status });
  return json({ ok: true }, 200, env);
}

// ---------- 라우팅 ----------

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!isAllowedOrigin(request, env)) {
      return json({ error: "허용되지 않은 요청 출처입니다.", code: "ORIGIN_NOT_ALLOWED" }, 403, { ...env, SUPPRESS_CORS: true });
    }
    env = { ...env, RESPONSE_ORIGIN: request.headers.get("Origin") || allowedOrigins(env)[0] };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    try {
      // 인증 불필요
      if (path === "/api/auth" && request.method === "POST") return await handleAuth(request, env);
      if (path === "/api/register" && request.method === "POST") return await handleRegister(request, env);
      if (path === "/api/companies" && request.method === "GET") return await handleCompanies(request, env);

      // 인증 필요
      const currentUserGoogle = await requireAuth(request, env);
      if (!currentUserGoogle) return json({ error: "로그인이 필요합니다." }, 401, env);

      const usersFile = await ghGetJson(env, "users.json");
      const userRecord = usersFile && usersFile.json[currentUserGoogle.email];
      if (accountStatusOf(userRecord) !== "approved") {
        return json({ error: "승인되지 않은 계정입니다." }, 403, env);
      }
      const currentUser = {
        email: currentUserGoogle.email,
        name: userRecord.name,
        company: userRecord.company,
        org: effectiveOrg(env, currentUserGoogle.email, userRecord), // ADMIN은 항상 hyundai
        tier: tierOf(env, currentUserGoogle.email, userRecord),
        isAdmin: isAdminEmail(env, currentUserGoogle.email),
      };

      if (path === "/api/managers" && request.method === "GET") return await handleManagers(request, env, url, currentUser, usersFile);
      if (path === "/api/users/pending" || path === "/api/users/approve") {
        // 가입 승인은 현대건설 소속 또는 ADMIN만 가능
        if (currentUser.org !== "hyundai" && !currentUser.isAdmin) {
          return json({ error: "권한이 없습니다." }, 403, env);
        }
        if (path === "/api/users/pending" && request.method === "GET") return await handlePendingUsers(request, env, usersFile);
        if (path === "/api/users/approve" && request.method === "POST") return await handleApproveUser(request, env, currentUser.email, usersFile);
      }
      if (path === "/api/signature" && request.method === "POST") return await handleSignatureUpload(request, env, currentUser.email, usersFile);
      if (path === "/api/signature" && request.method === "GET") return await handleGetMySignature(env, currentUser, usersFile);

      if (path.startsWith("/api/admin/")) {
        if (!currentUser.isAdmin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, env);
        if (path === "/api/admin/users" && request.method === "GET") return await handleAdminListUsers(env, usersFile);
        if (path === "/api/admin/signature" && request.method === "GET") return await handleAdminSignature(env, url, currentUser, usersFile);
        if (path === "/api/admin/users/update" && request.method === "POST") return await handleAdminUpdateUser(request, env, currentUser, usersFile);
        if (path === "/api/admin/rename-user" && request.method === "POST") return await handleAdminRenameUser(request, env, currentUser, usersFile);
        if (path === "/api/admin/users/status" && request.method === "POST") return await handleAdminSetStatus(request, env, currentUser, usersFile);
        if (path === "/api/admin/users/delete" && request.method === "POST") return await handleAdminDeleteUser(request, env, currentUser, usersFile);
        if (path === "/api/admin/rename-company" && request.method === "POST") return await handleAdminRenameCompany(request, env, currentUser, usersFile);
      }
      if (path === "/api/plans" && request.method === "GET") return await handleListPlans(request, env, url, currentUser);
      if (path === "/api/plans" && request.method === "POST") return await handleSavePlan(request, env, currentUser);

      const planIdMatch = path.match(/^\/api\/plans\/([^/]+)(\/(submit|execution-review|safety-approve|approve|reject|hyundai-manager|signatures))?$/);
      if (planIdMatch) {
        const id = decodeURIComponent(planIdMatch[1]);
        const action = planIdMatch[3];
        if (!isSafePlanId(id)) return json({ error: "잘못된 작업계획서 번호입니다." }, 400, env);
        if (request.method === "GET" && !action) return await handleGetPlan(request, env, id, currentUser);
        if (request.method === "GET" && action === "signatures") return await handleGetPlanSignatures(env, id, currentUser, usersFile);
        if (request.method === "DELETE" && !action) return await handleDeletePlan(request, env, id, currentUser);
        if (request.method === "POST" && action === "submit") return await handleSubmitPlan(request, env, id, currentUser);
        if (request.method === "POST" && action === "execution-review") return await handleExecutionReview(request, env, id, currentUser, usersFile);
        if (request.method === "POST" && action === "safety-approve") return await handleSafetyApprove(request, env, id, currentUser, usersFile);
        if (request.method === "POST" && action === "approve") return await handleApprovePlan(request, env, id, currentUser, usersFile);
        if (request.method === "POST" && action === "reject") return await handleRejectPlan(request, env, id, currentUser);
        if (request.method === "POST" && action === "hyundai-manager") return await handleChangeHyundaiManager(request, env, id, currentUser);
      }

      return json({ error: "찾을 수 없는 요청입니다." }, 404, env);
    } catch (e) {
      if (e && e.expose) {
        return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status || 400, env);
      }
      const requestId = crypto.randomUUID();
      console.error("Unhandled API error", { requestId, method: request.method, path, error: e && e.stack ? e.stack : String(e) });
      return json({ error: "서버 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.", code: "INTERNAL_ERROR", requestId }, 500, env);
    }
  },
};

// Expose timings in DevTools without changing API response bodies.
export default {
  async fetch(request, env) {
    const start = performance.now();
    const timings = {};
    const response = await worker.fetch(request, { ...env, TIMINGS: timings });
    const entries = [`total;dur=${(performance.now() - start).toFixed(1)}`];
    for (const [name, entry] of Object.entries(timings)) entries.push(`${name};dur=${entry.duration.toFixed(1)};desc="${entry.count} calls"`);
    response.headers.set("Server-Timing", entries.join(", "));
    if (response.headers.has("Access-Control-Allow-Origin")) response.headers.set("Access-Control-Expose-Headers", "Server-Timing");
    return response;
  },
};
