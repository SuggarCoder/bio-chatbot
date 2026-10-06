import assert from 'node:assert/strict';
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
export function resolve(specifier, context, next) {
 if (specifier === '@electric-sql/pglite') return { url: ${JSON.stringify(new URL('../node_modules/.review-db/node_modules/@electric-sql/pglite/dist/index.js', import.meta.url).href)}, shortCircuit: true };
 return next(specifier, context);
}`), import.meta.url);
const { PGlite } = await import('../node_modules/.review-db/node_modules/@electric-sql/pglite/dist/index.js');
const { vector } = await import('../node_modules/.review-db/node_modules/@electric-sql/pglite/dist/vector/index.js');
const { drizzle } = await import('drizzle-orm/pglite');
const { migrate } = await import('drizzle-orm/pglite/migrator');
const { eq, sql } = await import('drizzle-orm');
const schema = await import('../src/server/db/schema.ts');
const api = await import('../src/server/db.ts');
const queue = await import('../src/server/generationQueue.ts');
const { mockUserInfoResponse } = await import('../src/server/auth.ts');
const watchdog = setTimeout(() => { console.error('SQL regression timed out'); process.exit(1) }, 120_000);
const client = new PGlite({ extensions: { vector } });
const db = drizzle(client, { schema });
try {
 await client.exec('CREATE EXTENSION IF NOT EXISTS vector');
 await migrate(db, { migrationsFolder: 'drizzle' });
 await migrate(db, { migrationsFolder: 'drizzle' });
 console.log('PASS: all migrations twice, including durable business reservation');
 const owner = await api.syncUser(db, { ...mockUserInfoResponse.data, userId: crypto.randomUUID() });
 const chat = await api.createChat(db, owner.id, 'business');
 let calls=0;
 const form = {projectCode:'p',projectName:'p',phone:'1',teamId:'t'};
 const input = {userId:owner.id,chatId:chat.id,clientMessageId:crypto.randomUUID(),content:'progress'};
 const execute=async()=>{ calls++; await db.execute(sql`select 1`); return {content:'form',part:{type:'gpas',order:1,form}} };
 const [first,second] = await Promise.all([api.createBusinessExchange(db,input,execute),api.createBusinessExchange(db,input,execute)]);
 assert.equal(calls,1); assert.equal(first.assistantMessage.id,second.assistantMessage.id);
 console.log('PASS: same-key concurrency deduplication; external callback can independently query DB');
 let release;
 let entered=0;
 const gate = new Promise(r=>release=r);
 const chats = await Promise.all(Array.from({length:4},()=>api.createChat(db,owner.id,'blocked HTTP')));
 const pending=chats.map(c=>api.createBusinessExchange(db,{...input,chatId:c.id,clientMessageId:crypto.randomUUID()},async()=>{entered++;await gate;return {content:'ok',part:{type:'gpas',order:1}}}));
 while(entered<4) await new Promise(r=>setTimeout(r,5));
 await db.execute(sql`select 1`);
 await assert.rejects(api.createGenerationStart(db,{userId:owner.id,chatId:chats[0].id,content:'blocked',
  clientMessageId:crypto.randomUUID(),requestId:crypto.randomUUID(),generationId:crypto.randomUUID(),streamId:crypto.randomUUID(),provider:'test',model:'test'}),e=>e.code==='business_operation_active');
 release(); await Promise.all(pending);
 console.log('PASS: four blocked external operations do not retain DB transactions');
 const mutation = {...input,clientMessageId:crypto.randomUUID(),teamId:'t',sourceMessageId:first.assistantMessage.id};
 await assert.rejects(api.createBusinessExchange(db,mutation,async()=>{throw new Error('timeout after send')}));
 await assert.rejects(api.createBusinessExchange(db,mutation,async()=>{throw new Error('duplicate external call')}),e=>e.code==='business_outcome_unknown');
 await assert.rejects(api.createBusinessExchange(db,{...mutation,clientMessageId:crypto.randomUUID()},async()=>{throw new Error('duplicate external call')}),e=>e.code==='business_operation_active');
 console.log('PASS: ambiguous external mutation is not replayed, including a new request ID');
 const resume = {...input,chatId:chats[0].id,clientMessageId:crypto.randomUUID()};
 await db.insert(schema.businessOperations).values({userId:owner.id,chatId:resume.chatId,requestId:resume.clientMessageId,token:crypto.randomUUID(),status:'result_ready',expiresAt:new Date(),result:{content:'stored',part:{type:'gpas',order:1}}});
 const recovered=await api.createBusinessExchange(db,resume,async()=>{throw new Error('must not execute')});
 assert.equal(recovered.assistantMessage.content,'stored');
 console.log('PASS: stored upstream result recovered after simulated crash');
 const fifoChat=await api.createChat(db,owner.id,'fifo');
 const starts=[];
 for(const content of ['A','B','C']) starts.push(await api.createGenerationStart(db,{userId:owner.id,chatId:fifoChat.id,content,clientMessageId:crypto.randomUUID(),requestId:crypto.randomUUID(),generationId:crypto.randomUUID(),streamId:crypto.randomUUID(),provider:'test',model:'test'}));
 await api.requestGenerationCancellation(db,owner.id,starts[0].generationId);
 await db.update(schema.generations).set({status:'queued'}).where(eq(schema.generations.id,starts[2].generationId));
 const c=await queue.loadGenerationWorkItem(db,{userId:owner.id,generationId:starts[2].generationId,attempt:0});
 assert.equal(await queue.claimGeneration(db,c,'worker'),false);
 await db.update(schema.generations).set({status:'queued'}).where(eq(schema.generations.id,starts[1].generationId));
 assert.equal(await queue.claimGeneration(db,c,'worker'),false);
 await api.requestGenerationCancellation(db,owner.id,starts[1].generationId);
 assert.equal(await queue.claimGeneration(db,c,'worker'),true);
 const { readTerminalEvent }=await import('../src/server/terminalEvent.ts');
 const stopped=await readTerminalEvent(db,owner.id,starts[0].generationId);
 assert.equal(stopped?.finishReason,'cancelled');
 assert.equal(await readTerminalEvent(db,owner.id,starts[2].generationId),null);
 console.log('PASS: C cannot overtake created/queued B; cancellation releases FIFO; durable terminal reader works');
 const { DurableIngress }=await import('../src/server/ingress.ts');
 const icfg={requestEncryptionKey:Buffer.alloc(32,7).toString('base64'),ingressConcurrency:2};
 const restartChat=await api.createChat(db,owner.id,'restart');
 const durableInput={userId:owner.id,chatId:restartChat.id,requestId:crypto.randomUUID(),payload:{content:'restart-safe'},cookie:'secret-session',externalUserId:'external',teamId:'team'};
 let executions=0;
 const handler=async(row,cookie,context)=>{assert.equal(cookie,'secret-session');await context.check();executions++;return {ok:true}};
 const oldInbox=new DurableIngress(icfg,db,handler);
 const accepted=await oldInbox.submit(durableInput); // Process dies before any planning.
 assert.equal(accepted.status,'queued');
 const [stored]=await db.select().from(schema.ingressRequests).where(eq(schema.ingressRequests.id,accepted.id));
 assert.ok(stored.credential && !stored.credential.includes('secret-session'));
 assert.equal((await oldInbox.submit(durableInput)).id,accepted.id);
 await assert.rejects(oldInbox.submit({...durableInput,payload:{content:'changed'}}),e=>e.code==='request_conflict');
 await assert.rejects(oldInbox.submit({...durableInput,requestId:crypto.randomUUID()}),e=>e.code==='request_pending');
 assert.equal(await oldInbox.get(crypto.randomUUID(),accepted.id),null);
 const recoveredInbox=new DurableIngress(icfg,db,handler);
 await recoveredInbox.tick();await recoveredInbox.stop();
 assert.equal(executions,1);
 assert.equal((await recoveredInbox.get(owner.id,accepted.id)).status,'succeeded');
 const [completed]=await db.select().from(schema.ingressRequests).where(eq(schema.ingressRequests.id,accepted.id));
 assert.equal(completed.credential,null);
 console.log('PASS: accepted ingress survives processor restart, ciphertext-only credential purged on completion, owner scope, payload conflict and same-key replay');
 // A crash after the plan is committed does not re-plan or lose that decision.
 const again=await oldInbox.submit({...durableInput,requestId:crypto.randomUUID()});
 await db.update(schema.ingressRequests).set({status:'running',token:crypto.randomUUID(),leaseUntil:new Date(0),plan:{mode:'general'}}).where(eq(schema.ingressRequests.id,again.id));
 const recoveredRunning=new DurableIngress(icfg,db,async(row)=>{assert.equal(row.plan.mode,'general');return {recovered:true}});
 await recoveredRunning.tick();await recoveredRunning.stop();
 assert.equal((await recoveredRunning.get(owner.id,again.id)).status,'succeeded');
 console.log('PASS: expired running lease reclaimed, saved plan retained');
 // A stale process cannot overwrite the recovered owner's result.
 const fencing=await oldInbox.submit({...durableInput,requestId:crypto.randomUUID()});
 let unblock,ingressEntered; const barrier=new Promise(r=>unblock=r), started=new Promise(r=>ingressEntered=r);
 const stale=new DurableIngress(icfg,db,async()=>{ingressEntered();await barrier;return {stale:true}});
 await stale.tick();await started;
 await db.update(schema.ingressRequests).set({leaseUntil:new Date(0)}).where(eq(schema.ingressRequests.id,fencing.id));
 const fresh=new DurableIngress(icfg,db,async()=>({fresh:true}));await fresh.tick();await fresh.stop();
 unblock();await stale.stop();
 assert.deepEqual((await fresh.get(owner.id,fencing.id)).result,{fresh:true});
 console.log('PASS: stale ingress completion fenced out after recovery');
 const { buildApp }=await import('../src/server/app.ts');
 const { GenerationService }=await import('../src/server/generation.ts');
 const { createCapabilityRuntime }=await import('../src/server/capabilities/runtime.ts');
 const concurrency=Number(process.env.REVIEW_CONCURRENCY ?? 100);
 const cfg={requestEncryptionKey:Buffer.alloc(32,7).toString('base64'),ingressConcurrency:8,plannerConcurrency:4,nodeEnv:'test',serveClient:false,gpas2AuthMode:'upstream',gpas2UserInfoUrl:'https://mock.invalid/user/info',
  qwenApiKey:'mock',qwenBaseUrl:'https://mock.invalid/v1',qwenModel:'mock',redisPrefix:'review:',
  chatRateLimitPerMinute:10,monthlyTokenLimit:0,contextMemoryEnabled:false,userMemoryEnabled:false,
  artifactContextV2Enabled:false,artifactProtocolEnabled:false,qwenTokenizerPath:'models/qwen-tokenizer'};
 const redis={isReady:true,eval:async()=>[1,0,9],get:async()=>null,set:async()=> 'OK'};
 const runtime=createCapabilityRuntime(cfg,{embed:async()=>Array.from({length:512},(_,i)=>i===0?1:0)});
 const oldFetch=globalThis.fetch;
 let planning=0,peakPlanning=0;
 globalThis.fetch=async(input,options)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.pathname==='/user/info') {
   const cookie=new Headers(options?.headers??input.headers).get('cookie');
   const name=cookie?.split('=')[1];
   return Response.json({code:200,data:{...mockUserInfoResponse.data,userId:name,ownteamId:`team-${name}`}});
  }
  if(url.pathname.includes('/project/exist/')) {
   const teamId=decodeURIComponent(url.pathname.split('/').at(-1));
   await new Promise(r=>setTimeout(r,2));
   return Response.json({code:200,data:false,info:{projectCode:'p',userName:'p',teamId}});
  }
  planning++;peakPlanning=Math.max(peakPlanning,planning);
  const body=JSON.parse(options.body);
  const text=JSON.parse(body.input).text;
  await new Promise(r=>setTimeout(r,2));planning--;
  const decision=text==='business'?{intent:'query',scope:'self',capabilityId:'project.progress',confidence:1}:{intent:'general',scope:'unspecified',capabilityId:null,confidence:1};
  return Response.json({id:'mock',object:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(decision)}]}]});
 };
 const app=await buildApp({config:cfg,database:db,redis,generations:new GenerationService(cfg,db,redis,{},{}),
  streamHub:{},objectStore:null,artifactService:null,capabilityRuntime:runtime});
 try {
  const identities=[];
  for(let n=0;n<concurrency;n++) {
   const name=`http-${n}`;
   const u=await api.syncUser(db,{...mockUserInfoResponse.data,userId:name,ownteamId:`team-${name}`});
   identities.push({name,user:u,chat:await api.createChat(db,u.id,'chat'),business:await api.createChat(db,u.id,'business')});
  }
  for(const mode of ['chat','business']) {
   const results=await Promise.all(identities.map(u=>app.inject({method:'POST',url:`/ai-chatbot/api/conversations/${u[mode].id}/messages`,
    headers:{cookie:`u=${u.name}`,'idempotency-key':crypto.randomUUID()},payload:{content:mode==='chat'?'hello':'business'}})));
   const bad=results.filter(r=>r.statusCode!==202);
   assert.equal(bad.length,0,bad.slice(0,3).map(r=>r.body).join('\n'));
   const ids=results.map(r=>r.json().id);
   for (;;) {
    const rows=await db.select().from(schema.ingressRequests);
    const mine=rows.filter(row=>ids.includes(row.id));
    assert.equal(mine.filter(row=>row.status==='failed').length,0,JSON.stringify(mine.filter(row=>row.status==='failed')));
    if(mine.every(row=>row.status==='succeeded')) break;
    await new Promise(r=>setTimeout(r,50));
   }
   console.log(`PASS: ${concurrency} distinct authenticated users submit ${mode}; all return durable 202 and complete (mock upstream, PGlite)`);
  }
  assert.equal(peakPlanning,4);
 } finally { await app.close(); globalThis.fetch=oldFetch; }

} finally { await client.close(); clearTimeout(watchdog); }
