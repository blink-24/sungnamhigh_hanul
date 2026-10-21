export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Share the in-flight promise as well as the result. A failed refresh is briefly
// cached too, so an unavailable upstream is not hammered by simultaneous readers.
export class SharedCache {
  constructor(ttl = 20_000, staleFor = 300_000) {
    this.ttl = ttl; this.staleFor = staleFor; this.value = null;
    this.updated = 0; this.retryAfter = 0; this.pending = null; this.failure = null;
  }
  invalidate() { this.updated = 0; this.retryAfter = 0; }
  async get(load) {
    const now = Date.now();
    if (this.value && now - this.updated < this.ttl) return { value: this.value, stale: false };
    if (now < this.retryAfter) {
      if (this.value && now - this.updated < this.staleFor) return { value: this.value, stale: true };
      throw this.failure;
    }
    if (!this.pending) {
      this.pending = (async () => {
        try {
          const value = await load();
          this.value = value; this.updated = Date.now(); this.failure = null;
          return { value, stale: false };
        } catch (error) {
          this.failure = error; this.retryAfter = Date.now() + 5_000;
          if (this.value && Date.now() - this.updated < this.staleFor) return { value: this.value, stale: true };
          throw error;
        } finally { this.pending = null; }
      })();
    }
    return this.pending;
  }
}

export function boardId(input) {
  const value = String(input || '').trim();
  if (/^[a-zA-Z0-9_]{10,40}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(^|\.)padlet\.(com|org)$/.test(url.hostname)) throw Error();
    const last = url.pathname.split('/').filter(Boolean).pop() || '';
    const id = last.split('-').pop();
    if (/^[a-zA-Z0-9_]{10,40}$/.test(id)) return id;
  } catch {}
  throw new AppError(400, '패들렛의 전체 주소 또는 Developer info의 API ID를 입력해 주세요.');
}

export function plainText(value) {
  return String(value || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*(br\b[^>]*|\/p|\/div|\/li|\/h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, name) => {
      if (name[0] !== '#') return ({amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' '})[name.toLowerCase()] || match;
      const n = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
    }).replace(/\n[ \t]*\n[ \t]*\n/g, '\n\n').trim();
}

export function padletBoard(board, posts) {
  if (!board?.data?.id || !Array.isArray(posts)) throw new AppError(502, '패들렛 응답 형식을 확인할 수 없습니다.');
  const sections = (board.included || []).filter(x => x.type === 'section').map(x => ({ id: String(x.id), title: plainText(x.attributes?.title) || '이름 없는 섹션' }));
  const sectionNames = new Map(sections.map(x => [x.id, x.title]));
  const articles = posts.filter(x => x.type === 'post' || !x.type).map(x => {
    const a = x.attributes || {}; const content = a.content || a;
    const sectionId = String(x.relationships?.section?.data?.id || 'unsectioned');
    if (!sectionNames.has(sectionId)) {
      const title = sectionId === 'unsectioned' ? '섹션 없음' : '기타 섹션';
      sections.push({id:sectionId, title}); sectionNames.set(sectionId, title);
    }
    const body = plainText(content.bodyHtml || content.body || content.text).slice(0, 100_000);
    const title = plainText(content.subject || content.title).slice(0, 300) || body.split('\n')[0].slice(0, 100) || '제목 없는 기사';
    let url = a.webUrl?.live || a.webUrl || content.url || board.data.attributes?.webUrl?.live || board.data.attributes?.webUrl || '';
    try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || !/(^|\.)padlet\.(com|org)$/.test(parsed.hostname)) url = ''; } catch { url = ''; }
    return {id:String(x.id), title, content:body, summary:body.replace(/\s+/g,' ').slice(0,160), sectionId, category:sectionNames.get(sectionId), url};
  });
  return {id:String(board.data.id), title:plainText(board.data.attributes?.title) || '2026 한울', sections, articles};
}

export const affiliations = ['재학생', '외부 학생', '학부모/주민', '교직원'];
export function validateFeedback(body, articles) {
  if (!body || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId || '')) throw new AppError(400, '제출 번호가 올바르지 않습니다. 페이지를 새로고침해 주세요.');
  if (!affiliations.includes(body.affiliation) || !['남성','여성'].includes(body.gender)) throw new AppError(400, '소속과 성별을 선택해 주세요.');
  const article = articles.find(a => a.id === body.articleId);
  if (!article) throw new AppError(400, '현재 게시된 기사를 선택해 주세요.');
  if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) throw new AppError(400, '별점을 1~5점 중 선택해 주세요.');
  const review = typeof body.review === 'string' ? body.review.trim() : '';
  if (!review || review.length > 1000) throw new AppError(400, '한 줄 평은 1~1,000자로 작성해 주세요.');
  return {requestId:body.requestId, affiliation:body.affiliation, gender:body.gender, articleId:article.id, article:article.title, rating:body.rating, review,
    ticketId:`#HN-2026-${body.requestId.replaceAll('-','').slice(0,12).toUpperCase()}`};
}

export function validateDashboard(result) {
  const d = result?.dashboard;
  if (result?.success !== true || !d || !Number.isSafeInteger(d.total) || d.total < 0 || !Number.isFinite(d.average) || d.average < 0 || d.average > 5 || !Number.isInteger(d.external) || d.external < 0 || d.external > d.total || !Array.isArray(d.articles) || !Array.isArray(d.affiliations)) throw new AppError(502, '구글 시트 집계 API가 올바른 데이터를 반환하지 않았습니다. Apps Script 배포를 확인해 주세요.');
  for (const rows of [d.articles,d.affiliations]) {
    if (rows.some(x => typeof x.label !== 'string' || !Number.isSafeInteger(x.count) || x.count < 0) || rows.reduce((sum,x)=>sum+x.count,0) !== d.total) throw new AppError(502, '구글 시트의 집계 합계가 일치하지 않습니다.');
  }
  if (!Number.isFinite(Date.parse(d.updatedAt))) throw new AppError(502, '구글 시트 갱신 시각을 확인할 수 없습니다.');
  return {total:d.total, average:d.average, external:d.external, articles:d.articles.map(x=>({label:x.label,count:x.count})), affiliations:d.affiliations.map(x=>({label:x.label,count:x.count})), updatedAt:d.updatedAt};
}
