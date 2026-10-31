import { t, setLocale } from '../src/locale';
import { configureNetwork } from '../src/network';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { PlanAuth } from '../src/auth';
import { CredentialStore } from '../src/platform';
import { loadConfig, safeError, LOCAL } from '../src/config';
import { PlusBrain, type BrainTiming, type HTTPTransport, type RoomSnapshot } from '../src/llm';
import { ResponsesTransport } from '../src/responses-transport';
const config = await loadConfig(), auth = new PlanAuth(new CredentialStore());
setLocale(config.locale);
configureNetwork(config.networkMode);
const sessionId = crypto.randomUUID(), token = await auth.token();
const socket = new ResponsesTransport('websocket');
const rows: any[] = [];
const began = Date.now();
const rounds = Number(process.argv.find(a => a.startsWith('--rounds='))?.split('=')[1] ?? 2);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 4) throw new Error(t("rounds must be 1..4"));
try {
 await socket.warm(sessionId, token);
 for(let round=0;round<rounds;round++) for(let scenario=0;scenario<2;scenario++) {
  const snapshot: RoomSnapshot = { sessionId,botName:config.botName,now:1793091600000,members:[{id:'synthetic',name:'Тест'}],
   events:[{id:1,kind:'speech',at:1793091599000,end:1793091599500,userId:'synthetic',name:'Тест',text:scenario?`${config.botName}, ответь ровно: Лучше встретиться у метро.`:`${config.botName}, ответь ровно: Да, я здесь.`}],
   responsePolicy:{triggerEventIds:[1],maxChars:240,preparingEarly:true} };
  for(const mode of (round+scenario)%2?['websocket','http']:['http','websocket']){
   let inputHash=''; const timings:BrainTiming[]=[];
   const transport:HTTPTransport=async(url,init)=>{inputHash=createHash('sha256').update(JSON.stringify(JSON.parse(String(init.body)).input)).digest('hex');return mode==='http'?fetch(url,init):socket.fetch(url,init);};
   const brain=new PlusBrain(auth,config,transport), start=performance.now();
   const reply=await brain.reply(snapshot,AbortSignal.timeout(25000),{onSentence:()=>{},onTiming:t=>timings.push(t)});
   const row={round,scenario,mode,inputHash,firstTextMs:timings.find(t=>t.stage==='first_text')?.elapsedMs,firstSentenceMs:timings.find(t=>t.stage==='first_sentence')?.elapsedMs,completedMs:Math.round(performance.now()-start),headersMs:timings.find(t=>t.stage==='response_headers')?.elapsedMs,inputTokens:timings.find(t=>t.stage==='model_completed')?.inputTokens,cachedTokens:timings.find(t=>t.stage==='model_completed')?.cachedTokens,speak:reply.speak,chars:reply.text.length};
   rows.push(row); console.log(JSON.stringify(row)); brain.release(sessionId);
  }
 }
}catch(error){console.log(JSON.stringify({error:safeError(error)}));process.exitCode=1;}
finally {
 socket.release(sessionId); await mkdir(LOCAL, { recursive: true });
 const path = resolve(LOCAL, `text-transport-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
 await Bun.write(path, JSON.stringify({at:new Date().toISOString(),elapsedMs:Date.now()-began,model:config.model,scope:'Synthetic production-prompt text requests; warmed WebSocket; no Discord or TTS; same account and network configuration; balanced order; small diagnostic sample',rows},null,2));
 console.log(t("Report: {0}", path));
}
