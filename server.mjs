import http from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { AppError, SharedCache, boardId, padletBoard, validateFeedback, validateDashboard } from './lib/core.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SHEETS_URL = 'https://script.google.com/macros/s/AKfycbzw9VM7nFSoZmMBFgPe6tWXjMt58GASJJ52rpDk9UpfFkJM8VWYdkQaHCr4uY2SRNm1Kw/exec';
const hash = s => createHash('sha256').update(Buffer.isBuffer(s)?s:String(s)).digest();

export async function createApp(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || resolve(ROOT,'data'));
  const settingsPath = resolve(dataDir,'settings.json');
  const fetchImpl = options.fetchImpl || fetch;
  const apiKey = options.padletApiKey ?? process.env.PADLET_API_KEY ?? '';
  const sheetsToken = options.sheetsToken ?? process.env.SHEETS_TOKEN ?? '';
  const passwordHash = hash(options.adminPassword ?? process.env.ADMIN_PASSWORD ?? 'ADMIN');
  const sheetsUrl = options.sheetsUrl ?? process.env.SHEETS_URL ?? DEFAULT_SHEETS_URL;
  if (sheetsUrl && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(sheetsUrl)) throw Error('SHEETS_URL must be an HTTPS Google Apps Script deployment URL.');
  let settings = {boardId:'', boardTitle:'2026 한울', selectedIds:[], articles:[], publishedAt:null};
  try { settings = JSON.parse(await readFile(settingsPath,'utf8')); }
  catch(error) { if (error.code !== 'ENOENT') throw Error('Saved settings are unreadable; restore data/settings.json before starting.'); }
  if (!Array.isArray(settings.articles) || !Array.isArray(settings.selectedIds)) throw Error('Saved settings are invalid.');
  const sessions = new Map(), loginLimits = new Map(), submitLimits = new Map(), receipts = new Map(), padletCaches = new Map();
  const dashboardCache = new SharedCache();
  let pendingWrites = 0, flushTimer = null, flushing = false, publishing = false;
  const writeBatch = [];
  const staticFiles = new Map();
  for (const [url,file,type] of [['/','index.html','text/html; charset=utf-8'],['/index.html','index.html','text/html; charset=utf-8'],['/app.js','app.js','text/javascript; charset=utf-8'],['/styles.css','styles.css','text/css; charset=utf-8'],['/assets/hanul-logo.webp','assets/hanul-logo.webp','image/webp']]) {
    try { const body=await readFile(resolve(ROOT,file)); staticFiles.set(url,{body,type,etag:`"${hash(body).toString('hex').slice(0,20)}"`}); }
    catch(error) { if (error.code !== 'ENOENT') throw error; }
  }
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of sessions) if (value < now) sessions.delete(key);
    for (const map of [loginLimits,submitLimits]) for (const [key,value] of map) if (value.until < now) map.delete(key);
    for (const [key,value] of receipts) if (!value.pending && value.until < now) receipts.delete(key);
  },60_000).unref();

  function limit(map, key, max, duration) {
    const now = Date.now(); let entry = map.get(key);
    if (!entry || entry.until <= now) {entry = {count:0,until:now+duration}; map.set(key,entry);}
    if (++entry.count > max) throw new AppError(429, '요청이 많습니다. 잠시 후 다시 시도해 주세요.');
  }
  function isAdmin(req) {
    const token = /(?:^|;\s*)hanul_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    return token && (sessions.get(token) || 0) > Date.now();
  }
  function requireAdmin(req) { if (!isAdmin(req)) throw new AppError(401,'관리자 로그인이 필요합니다.'); }
  function json(res,status,body) {
    res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify(body));
  }
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415, 'JSON 요청만 허용됩니다.');
    let bytes = 0; const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 32_768) throw new AppError(413,'요청 내용이 너무 큽니다.');
      chunks.push(chunk);
    }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value; }
    catch { throw new AppError(400,'요청 형식이 올바르지 않습니다.'); }
  }
  async function upstream(url, init = {}) {
    let response;
    try { response = await fetchImpl(url,{...init,signal:AbortSignal.timeout(20_000)}); }
    catch { throw new AppError(503,'외부 서비스 연결이 지연되거나 차단되었습니다. 잠시 후 다시 시도해 주세요.'); }
    if (!response.ok) throw new AppError(502,`외부 서비스에서 요청을 처리하지 못했습니다 (${response.status}). 연결 설정과 권한을 확인해 주세요.`);
    // Do not echo upstream bodies: they may contain private data or credentials.
    try { return await response.json(); } catch { throw new AppError(502,'연동 API가 JSON을 반환하지 않았습니다. Apps Script 웹 앱의 최신 배포를 확인해 주세요.'); }
  }
  async function padlet(path) {
    if (!apiKey) throw new AppError(503,'서버에 PADLET_API_KEY가 설정되지 않았습니다. 운영자에게 문의해 주세요.');
    const url = new URL(path,'https://api.padlet.dev/v1/');
    if (url.origin !== 'https://api.padlet.dev' || !url.pathname.startsWith('/v1/')) throw new AppError(502,'패들렛의 페이지 주소가 올바르지 않습니다.');
    return upstream(url.toString(), {redirect:'error',headers:{'X-API-KEY':apiKey, Accept:'application/vnd.api+json'}});
  }
  async function loadBoard(id) {
    if (!padletCaches.has(id)) {
      if (padletCaches.size >= 10) padletCaches.delete(padletCaches.keys().next().value);
      padletCaches.set(id,new SharedCache(60_000,0));
    }
    const {value} = await padletCaches.get(id).get(async () => {
      const board = await padlet(`boards/${encodeURIComponent(id)}?include=sections`);
      let path = `boards/${encodeURIComponent(id)}/posts`; const posts = [], seen = new Set();
      for (let page = 0; path; page++) {
        if (page >= 100 || seen.has(path)) throw new AppError(502,'패들렛 페이지를 끝까지 읽지 못했습니다. 게시하지 않고 중단합니다.');
        seen.add(path);
        const result = await padlet(path);
        if (!Array.isArray(result.data)) throw new AppError(502,'패들렛 기사 목록 형식이 올바르지 않습니다.');
        posts.push(...result.data);
        const next = result.links?.next;
        const nextPath = typeof next === 'object' ? next?.href : next;
        path = nextPath ? new URL(nextPath,new URL(path,'https://api.padlet.dev/v1/')).toString() : null;
      }
      return padletBoard(board,[...new Map(posts.map(p=>[String(p.id),p])).values()]);
    });
    return value;
  }

  // A short collection window combines simultaneous visitors into one Sheets
  // request. Each visitor still receives their own confirmed receipt.
  function enqueueFeedback(value) {
    pendingWrites++;
    const promise = new Promise((resolve,reject)=>writeBatch.push({value,resolve,reject}));
    if (!flushing && !flushTimer) flushTimer = setTimeout(flushFeedback,80);
    return promise;
  }
  async function flushFeedback() {
    flushTimer = null;
    if (flushing || !writeBatch.length) return;
    flushing = true;
    const batch = writeBatch.splice(0,50);
    try {
      const result = await upstream(sheetsUrl,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({sharedSecret:sheetsToken,entries:batch.map(x=>x.value)})});
      if (result.success !== true || !Array.isArray(result.receipts)) throw new AppError(502,'구글 시트 저장 확인을 받지 못했습니다. 같은 내용으로 다시 시도해 주세요.');
      const confirmed = new Map(result.receipts.map(x=>[x.requestId,x.ticketId]));
      for (const item of batch) {
        if (confirmed.get(item.value.requestId) !== item.value.ticketId) item.reject(new AppError(502,'구글 시트의 제출 확인 번호가 일치하지 않습니다. 같은 내용으로 다시 시도해 주세요.'));
        else item.resolve({ok:true,ticketId:item.value.ticketId});
      }
      dashboardCache.invalidate();
    } catch(error) { for (const item of batch) item.reject(error); }
    finally {
      pendingWrites -= batch.length; flushing = false;
      if (writeBatch.length) flushTimer = setTimeout(flushFeedback,0);
    }
  }

  const server = http.createServer(async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url,'http://local'); const route = url.pathname;
      const ip = req.socket.remoteAddress || 'unknown';
      if (!['GET','HEAD'].includes(req.method)) {
        const origin = req.headers.origin;
        if ((origin && new URL(origin).host !== req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403,'동일한 사이트에서 요청해 주세요.');
      }
      if (['GET','HEAD'].includes(req.method) && staticFiles.has(route)) {
        const file = staticFiles.get(route); const etag = file.etag;
        res.setHeader('Cache-Control',route.startsWith('/assets/')?'public, max-age=86400':'public, max-age=0, must-revalidate');
        res.setHeader('ETag',etag);
        if (req.headers['if-none-match'] === etag) {res.writeHead(304); return res.end();}
        res.writeHead(200,{'Content-Type':file.type}); return res.end(req.method==='HEAD'?undefined:file.body);
      }
      if (req.method === 'GET' && route === '/api/health') return json(res,200,{ok:true});
      if (req.method === 'POST' && route === '/api/admin/login') {
        limit(loginLimits,ip,10,60_000);
        const value = await body(req);
        if (typeof value.password !== 'string' || !timingSafeEqual(hash(value.password),passwordHash)) throw new AppError(401,'비밀번호가 올바르지 않습니다.');
        const token = randomBytes(32).toString('hex'); sessions.set(token,Date.now()+8*60*60_000);
        const secure = req.socket.encrypted || (process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-proto'] === 'https');
        res.setHeader('Set-Cookie',`hanul_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure?'; Secure':''}`);
        return json(res,200,{ok:true});
      }
      if (req.method === 'POST' && route === '/api/admin/logout') {
        const token = /hanul_session=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1]; sessions.delete(token);
        res.setHeader('Set-Cookie','hanul_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return json(res,200,{ok:true});
      }
      if (req.method === 'GET' && route === '/api/admin/settings') {
        requireAdmin(req); return json(res,200,{...settings,padletConfigured:Boolean(apiKey),sheetsConfigured:Boolean(sheetsUrl&&sheetsToken)});
      }
      if (req.method === 'POST' && route === '/api/admin/padlet') {
        requireAdmin(req); const value = await body(req);
        const id = boardId(value.board);
        return json(res,200,await loadBoard(id));
      }
      if (req.method === 'PUT' && route === '/api/admin/publish') {
        requireAdmin(req); const value = await body(req);
        if (publishing) throw new AppError(409,'다른 게시 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
        publishing = true;
        try {
          const id = boardId(value.boardId);
          if (!Array.isArray(value.selectedIds) || value.selectedIds.length > 500 || value.selectedIds.some(x=>typeof x!=='string')) throw new AppError(400,'게시할 기사 선택이 올바르지 않습니다 (최대 500개).');
          const board = await loadBoard(id); const selectedIds = [...new Set(value.selectedIds)];
          const articles = board.articles.filter(x=>selectedIds.includes(x.id));
          if (articles.length !== selectedIds.length) throw new AppError(409,'패들렛 기사가 변경되었습니다. 목록을 다시 불러와 주세요.');
          const next = {boardId:id,boardTitle:board.title,selectedIds,articles,publishedAt:new Date().toISOString()};
          await mkdir(dataDir,{recursive:true,mode:0o700});
          const temp = `${settingsPath}.${randomBytes(6).toString('hex')}.tmp`;
          await writeFile(temp,JSON.stringify(next,null,2),{mode:0o600}); await rename(temp,settingsPath); settings = next;
          return json(res,200,{ok:true,count:articles.length});
        } finally { publishing = false; }
      }
      if (req.method === 'GET' && route === '/api/articles') return json(res,200,{articles:settings.articles,boardTitle:settings.boardTitle,publishedAt:settings.publishedAt});
      if (req.method === 'GET' && route === '/api/dashboard') {
        if (!sheetsUrl) throw new AppError(503,'구글 시트 연결이 설정되지 않았습니다.');
        const result = await dashboardCache.get(async () => {
          const target = new URL(sheetsUrl); target.searchParams.set('action','dashboard');
          return validateDashboard(await upstream(target.toString()));
        });
        return json(res,200,{dashboard:result.value,stale:result.stale});
      }
      if (req.method === 'POST' && route === '/api/feedback') {
        const value = validateFeedback(await body(req),settings.articles);
        if (!sheetsUrl || !sheetsToken) throw new AppError(503,'시트 저장 연결이 준비되지 않았습니다. 운영자에게 문의해 주세요.');
        const fingerprint = hash(JSON.stringify(value)).toString('hex');
        let receipt = receipts.get(value.requestId);
        if (receipt && receipt.fingerprint !== fingerprint) throw new AppError(409,'동일한 제출 번호의 내용이 변경되었습니다. 페이지를 새로고침해 주세요.');
        if (!receipt) {
          limit(submitLimits,ip,120,60_000); // Supports a classroom sharing one NAT.
          if (pendingWrites >= 100) throw new AppError(503,'제출 대기열이 가득 찼습니다. 잠시 후 다시 시도해 주세요.');
          receipt = {fingerprint,until:Date.now()+24*60*60_000,pending:true};
          receipt.promise = enqueueFeedback(value);
          receipts.set(value.requestId,receipt);
          receipt.promise.then(()=>{receipt.pending=false;},()=>{receipts.delete(value.requestId);});
        }
        return json(res,200,await receipt.promise);
      }
      throw new AppError(404,'요청한 페이지를 찾을 수 없습니다.');
    } catch(error) {
      if (!res.headersSent) json(res,error.status || 500,{error:error.status?error.message:'서버 처리 중 오류가 발생했습니다. 다시 시도해 주세요.'});
      else res.end();
    }
  });
  server.requestTimeout=45_000; server.headersTimeout=10_000; server.keepAliveTimeout=5_000;
  server.on('close',()=>clearInterval(cleanup));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await createApp();
  const port = Number(process.env.PORT || 8000); const host = process.env.HOST || '127.0.0.1';
  server.listen(port,host,()=>console.log(`Hanul server listening on ${host}:${port}`));
}
