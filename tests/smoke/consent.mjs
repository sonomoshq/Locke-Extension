// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Linux-only, opt-in consent integration test. See docs/testing/DATA-CONSENT.md.
import puppeteer from 'puppeteer';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {strict as assert} from 'node:assert';
import http from 'node:http';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const firefox = process.argv[2] || process.env.FIREFOX_BIN;
if (process.platform !== 'linux' || !firefox) throw new Error('Requires Linux and a Firefox executable argument (or FIREFOX_BIN).');
const home=mkdtempSync(join(tmpdir(), 'locke-consent-browser-'));
const nativeDir=join(home,'.mozilla/native-messaging-hosts'); mkdirSync(nativeDir,{recursive:true});
const log=join(home,'native.jsonl'), host=join(home,'native.py');
writeFileSync(host, `#!/usr/bin/env python3
import sys,json,struct
header=sys.stdin.buffer.read(4)
if len(header)==4:
 data=json.loads(sys.stdin.buffer.read(struct.unpack('<I',header)[0]))
 with open(${JSON.stringify(log)},'a') as f: f.write(json.dumps(data)+'\\n')
 reply={'type':'receipt','receipt':{'decision':'allow'}} if data.get('type')=='capture' else {'type':'status','connected':True}
 raw=json.dumps(reply).encode()
 sys.stdout.buffer.write(struct.pack('<I',len(raw))+raw);sys.stdout.buffer.flush()
`,{mode:0o755});
writeFileSync(join(nativeDir,'ai.sonomos.desktop.json'),JSON.stringify({name:'ai.sonomos.desktop',description:'Disposable consent QA fixture',path:host,type:'stdio',allowed_extensions:['desktop-connector@sonomos.ai']}));
const posts=[];const server=http.createServer((req,res)=>{let body='';req.on('data',s=>body+=s);req.on('end',()=>{posts.push({url:req.url,body});res.writeHead(200,{'content-type':'application/json'});res.end('{}');});});
// Refuse to run if the port is occupied; never reuse a real desktop service.
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(18795,'127.0.0.1',resolve);});
// Avoid Puppeteer's waitForFunction helper: older Firefox enforces the
// extension CSP against that helper's dynamic Function construction.
async function until(page, predicate) {
 for(let i=0;i<100;i++){if(await page.evaluate(predicate))return;await new Promise(resolve=>setTimeout(resolve,50));}
 throw new Error('Timed out waiting for the consent UI');
}
let b;
const native=()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
try {
 b=await puppeteer.launch({browser:'firefox',executablePath:firefox,headless:true,env:{...process.env,HOME:home},timeout:20000});
 console.log('Browser',await b.version());
 await b.installExtension(join(root,'dist/firefox'));
 let consent;
 for(let i=0;i<30&&!consent;i++){for(const p of await b.pages()){try{if(await p.evaluate(()=>document.getElementById('allowConsent')!==null))consent=p;}catch{}}if(!consent)await new Promise(r=>setTimeout(r,100));}
 assert.ok(consent,'focused consent tab exists');
 await until(consent, ()=>!document.getElementById('allowConsent').disabled);
 assert.equal(await consent.$eval('#technicalConsent',e=>e.checked),false);
 assert.equal(native().length,0); assert.equal(posts.length,0);
 console.log('PASS focused initial disclosure, optional choice off, zero native/presence transfer');
 const capture=()=>consent.evaluate(()=>browser.runtime.sendMessage({type:'capture',requestB64:btoa('POST /consent-test HTTP/1.1\r\nHost: test.invalid\r\n\r\nsynthetic fixture')}));
 assert.equal((await capture()).code,'data-consent-required'); assert.equal(native().length,0);
 console.log('PASS actual runtime rejects capture before consent');
 await consent.click('#allowConsent');
 await until(consent, ()=>document.getElementById('consentStatus').textContent.includes('enabled'));
 assert.equal((await capture()).receipt.decision,'allow');
 assert.equal(native().filter(x=>x.type==='capture').length,1);
 assert.equal(posts.length,0);
 console.log('PASS actual user click enables native capture with optional metadata still off');
 await consent.click('#pauseConsent');
 await until(consent, ()=>document.getElementById('consentStatus').textContent.includes('paused'));
 const count=native().length;
 assert.equal((await capture()).code,'data-consent-required'); assert.equal(native().length,count);
 console.log('PASS actual user pause revokes transfer');
 await consent.evaluate(()=>browser.tabs.create({url:browser.runtime.getURL('popup/consent.html'),active:true}));
 const oldConsent=consent;
 for(let i=0;i<30;i++){for(const p of await b.pages()){if(p===oldConsent)continue;try{if(await p.evaluate(()=>document.getElementById('allowConsent')!==null))consent=p;}catch{}}if(consent!==oldConsent)break;await new Promise(r=>setTimeout(r,100));}
 assert.notEqual(consent,oldConsent); await oldConsent.close();
 await until(consent, ()=>!document.getElementById('allowConsent').disabled);
 assert.equal((await capture()).code,'data-consent-required');
 console.log('PASS reopened consent page preserves refusal');
 await consent.screenshot({path:join(tmpdir(),'locke-consent-live.png'),fullPage:true});
 const page=await b.newPage(); let requestPosts=0;
 await page.setRequestInterception(true);
 page.on('request',req=>{if(req.method()==='POST')requestPosts++; void req.respond({status:200,contentType:'text/html',body:'<html><body>Local synthetic consent fixture</body></html>'});});
 await page.goto('https://chatgpt.com/');
 const pageSend=()=>page.evaluate(()=>fetch('/backend-api/conversation',{method:'POST',body:'synthetic consent fixture'}).then(()=>({sent:true})).catch(e=>({sent:false,error:e.message})));
 assert.match((await pageSend()).error,/Data sharing/); assert.equal(requestPosts,0);
 console.log('PASS actual page hook blocks before native transfer and before network');
 await consent.click('#allowConsent'); await until(consent, ()=>document.getElementById('consentStatus').textContent.includes('enabled'));
 await new Promise(r=>setTimeout(r,100));
 assert.equal((await pageSend()).sent,true); assert.equal(requestPosts,1);
 console.log('PASS actual page -> isolated relay -> native fixture -> allowed fetch');
 await consent.click('#pauseConsent'); await until(consent, ()=>document.getElementById('consentStatus').textContent.includes('paused'));
 assert.match((await pageSend()).error,/Data sharing/); assert.equal(requestPosts,1);
 console.log('PASS same-page revocation blocks subsequent request');
 // Simulate an extension update by reinstalling this exact temporary add-on.
 await b.installExtension(join(root,'dist/firefox'));
 await new Promise(r=>setTimeout(r,1000));
 const disclosed=[];for(const p of await b.pages()){try{if(await p.evaluate(()=>document.getElementById('allowConsent')!==null))disclosed.push(p);}catch{}}
 assert.equal(disclosed.length,0,'temporary reinstall closes extension tabs and must not reopen a declined disclosure');
 console.log('PASS same-version temporary reinstall does not re-prompt a recorded refusal');
 console.log('NOTE signed install/upgrade prompts, actual Edge, and desktop production pairing still require release QA');
} finally {if(b)await b.close();await new Promise(resolve=>server.close(resolve));rmSync(home,{recursive:true,force:true});}
