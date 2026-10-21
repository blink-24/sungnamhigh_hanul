/**
 * 한울 축제 웹 앱 — 기존 Apps Script를 이 파일로 교체합니다.
 * 기존 A~F열을 유지합니다. G~I열은 전용 열로 추가합니다.
 * 프로젝트 설정 > 스크립트 속성: HANUL_WEBHOOK_SECRET (서버 SHEETS_TOKEN과 동일)
 * 배포 > 배포 관리 > 수정 > 새 버전 > 배포 (실행: 나 / 액세스: 모든 사용자)
 */
var SPREADSHEET_ID = '1G2VHj4-GQMK_B0jmEWQE8vJUidqFUAxFv3xY02nEy8U';
var HANUL_CACHE_KEY = 'hanul-dashboard-v2';
var HANUL_HEADERS = ['제출 시간','방문자 소속','성별','평가할 기사','별점','한 줄 평 및 독자 소감','제출 확인 번호','중복 방지 번호','패들렛 기사 ID'];

function hanulJson(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
function hanulSheet() { return SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()[0]; }

function doGet(e) {
  try {
    if (!e || !e.parameter || e.parameter.action !== 'dashboard') return hanulJson({status:'online',version:2});
    var cache = CacheService.getScriptCache();
    var cached = cache.get(HANUL_CACHE_KEY);
    if (cached) return hanulJson({success:true,dashboard:JSON.parse(cached)});
    // Recheck under a lock so a cache expiry does not create many sheet reads.
    var lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      cached = cache.get(HANUL_CACHE_KEY);
      if (cached) return hanulJson({success:true,dashboard:JSON.parse(cached)});
      var sheet = hanulSheet();
      var rows = sheet.getLastRow() > 1 ? sheet.getRange(2,1,sheet.getLastRow()-1,6).getValues() : [];
      var articles = Object.create(null), affiliations = Object.create(null);
      var total = 0, sum = 0, external = 0;
      rows.forEach(function(row) {
        var rating = Number(row[4]);
        var article = String(row[3] || '').trim();
        var affiliation = String(row[1] || '').trim();
        // Ignore blank/invalid historical rows; never substitute sample data.
        if (!article || !affiliation || rating < 1 || rating > 5 || Math.floor(rating) !== rating) return;
        total++; sum += rating; if (affiliation !== '재학생') external++;
        articles[article] = (articles[article] || 0) + 1;
        affiliations[affiliation] = (affiliations[affiliation] || 0) + 1;
      });
      var dashboard = {total:total,average:total?sum/total:0,external:external,
        articles:Object.keys(articles).map(function(label){return {label:label,count:articles[label]};}),
        affiliations:Object.keys(affiliations).map(function(label){return {label:label,count:affiliations[label]};}),
        updatedAt:new Date().toISOString()};
      var encoded = JSON.stringify(dashboard);
      if (Utilities.newBlob(encoded).getBytes().length < 95000) cache.put(HANUL_CACHE_KEY,encoded,20);
      return hanulJson({success:true,dashboard:dashboard});
    } finally { lock.releaseLock(); }
  } catch(error) { return hanulJson({success:false,error:'시트 집계에 실패했습니다. 스프레드시트 권한과 배포 버전을 확인해 주세요.'}); }
}

function hanulEnsureColumns(sheet) {
  if (sheet.getMaxColumns() < 9) sheet.insertColumnsAfter(sheet.getMaxColumns(),9-sheet.getMaxColumns());
  if (sheet.getLastRow() === 0) { sheet.getRange(1,1,1,9).setValues([HANUL_HEADERS]); return; }
  var extra = sheet.getRange(1,7,1,3).getValues()[0];
  extra.forEach(function(value,index){
    if (value && value !== HANUL_HEADERS[index+6]) throw new Error('G~I열이 다른 용도로 사용 중입니다. 전용 열을 먼저 확보해 주세요.');
  });
  sheet.getRange(1,7,1,3).setValues([HANUL_HEADERS.slice(6)]);
}
function hanulLiteral(value) {
  var text = String(value || '');
  return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
}
function hanulEntry(value) {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId || '')) throw new Error('잘못된 제출 번호');
  if (['재학생','외부 학생','학부모/주민','교직원'].indexOf(value.affiliation) < 0 || ['남성','여성'].indexOf(value.gender) < 0) throw new Error('잘못된 응답');
  if (typeof value.article !== 'string' || !value.article.trim() || value.article.length > 300 || !value.articleId) throw new Error('잘못된 기사');
  if (typeof value.rating !== 'number' || value.rating < 1 || value.rating > 5 || Math.floor(value.rating) !== value.rating) throw new Error('잘못된 평점');
  if (typeof value.review !== 'string' || !value.review.trim() || value.review.length > 1000) throw new Error('잘못된 소감');
  var ticket = '#HN-2026-' + value.requestId.replace(/-/g,'').slice(0,12).toUpperCase();
  if (value.ticketId !== ticket) throw new Error('확인 번호 불일치');
  return value;
}
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('HANUL_WEBHOOK_SECRET');
    if (!secret || typeof data.sharedSecret !== 'string' || data.sharedSecret !== secret) return hanulJson({success:false,error:'저장 인증 설정을 확인해 주세요.'});
    var entries = Array.isArray(data.entries) ? data.entries : [data];
    if (!entries.length || entries.length > 50) throw new Error('잘못된 묶음 크기');
    entries = entries.map(hanulEntry);
    var lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      var sheet = hanulSheet(); hanulEnsureColumns(sheet);
      var existing = Object.create(null);
      if (sheet.getLastRow() > 1) sheet.getRange(2,7,sheet.getLastRow()-1,3).getValues().forEach(function(row){if(row[1])existing[String(row[1])] = {ticketId:String(row[0]),articleId:String(row[2])};});
      var now = Utilities.formatDate(new Date(),'Asia/Seoul','yyyy-MM-dd HH:mm:ss');
      var rows = [], receipts = [];
      entries.forEach(function(entry){
        var prior = existing[entry.requestId];
        if (prior && (prior.ticketId !== entry.ticketId || prior.articleId !== entry.articleId)) throw new Error('동일한 번호의 다른 요청');
        if (!prior) {
          rows.push([now,entry.affiliation,entry.gender,hanulLiteral(entry.article),entry.rating,hanulLiteral(entry.review),entry.ticketId,entry.requestId,entry.articleId]);
          existing[entry.requestId] = {ticketId:entry.ticketId,articleId:entry.articleId};
        }
        receipts.push({requestId:entry.requestId,ticketId:entry.ticketId});
      });
      if (rows.length) {
        var first = sheet.getLastRow()+1;
        if (first+rows.length-1 > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(),first+rows.length-1-sheet.getMaxRows());
        sheet.getRange(first,1,rows.length,9).setValues(rows);
        SpreadsheetApp.flush();
        CacheService.getScriptCache().remove(HANUL_CACHE_KEY);
      }
      return hanulJson({success:true,receipts:receipts});
    } finally { lock.releaseLock(); }
  } catch(error) { return hanulJson({success:false,error:'시트 저장에 실패했습니다. 입력값, 전용 열 및 Apps Script 실행 기록을 확인해 주세요.'}); }
}
