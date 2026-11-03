// SMC alert server: watches Twelve Data and pushes phone alerts through ntfy.sh. No dependencies, Node 18+.
const fs=require('fs');
const KEY=process.env.TWELVE_KEY||'',TOPIC=process.env.NTFY_TOPIC||'',SYMBOL=process.env.SYMBOL||'XAU/USD',
 TF=process.env.INTERVAL||'5min',POLL=Math.max(30,+process.env.POLL_SEC||120)*1000;
const STATE=process.env.STATE_FILE||'./fired.json';
let fired=new Set();try{fired=new Set(JSON.parse(fs.readFileSync(STATE,'utf8')))}catch(e){}
const save=()=>{try{fs.writeFileSync(STATE,JSON.stringify([...fired].slice(-300)))}catch(e){}};

const PL=5,WIN=120;
function pivotAt(d,p,hi){const v=hi?d[p].high:d[p].low;
 for(let j=p-PL;j<=p+PL;j++){if(j===p)continue;if(hi?d[j].high>=v:d[j].low<=v)return false}return true}
function calc(d){
 const n=d.length,ev=[],sig=[];let sh=null,sl=null,trend=0,hb=true,lb=true,last=-99;
 const atr=new Array(n).fill(0),e50=[],e200=[];let at=0,x=d[0].close,y=x;
 for(let i=0;i<n;i++){const c=d[i],pc=i?d[i-1].close:c.open,tr=Math.max(c.high-c.low,Math.abs(c.high-pc),Math.abs(c.low-pc));
  at=i<14?(at*i+tr)/(i+1):(at*13+tr)/14;atr[i]=at;x+=(c.close-x)*2/51;y+=(c.close-y)*2/201;e50[i]=x;e200[i]=y}
 const pos=i=>{let h=-1e9,l=1e9;for(let j=Math.max(0,i-WIN);j<=i;j++){if(d[j].high>h)h=d[j].high;if(d[j].low<l)l=d[j].low}return (d[i].close-l)/(h-l||1)};
 // a signal needs 4 of 5 checks: trigger, zone, strength, trend, candle direction
 const add=(i,dir,kind)=>{if(i-last<=8||i<200)return;
  const c=d[i],body=Math.abs(c.close-c.open),p=pos(i),wick=dir>0?Math.min(c.open,c.close)-c.low:c.high-Math.max(c.open,c.close);
  let sc=1;
  if(dir>0?p<0.5:p>0.5)sc++;
  if(kind==='break'?body>0.8*atr[i]:(wick>2*body&&wick>0.6*atr[i]))sc++;
  if(dir>0?(e50[i]>e200[i]&&c.close>e50[i]):(e50[i]<e200[i]&&c.close<e50[i]))sc++;
  if(dir>0?c.close>c.open:c.close<c.open)sc++;
  if(sc<4)return;
  const risk=1.5*atr[i],e=c.close;
  sig.push({i,dir,early:kind==='setup'?1:0,sc,e,sl:e-dir*risk,tp:e+dir*risk*1.5});last=i};
 for(let i=2*PL;i<n;i++){
  const p=i-PL;
  if(pivotAt(d,p,true)){sh={i:p,price:d[p].high};hb=false}
  if(pivotAt(d,p,false)){sl={i:p,price:d[p].low};lb=false}
  if(sh&&!hb&&d[i].close>sh.price){ev.push({type:trend===-1?'CHoCH':'BOS',dir:1,from:sh.i,to:i,price:sh.price});trend=1;hb=true;add(i,1,'break')}
  if(sl&&!lb&&d[i].close<sl.price){ev.push({type:trend===1?'CHoCH':'BOS',dir:-1,from:sl.i,to:i,price:sl.price});trend=-1;lb=true;add(i,-1,'break')}
  if(last!==i){add(i,1,'setup');if(last!==i)add(i,-1,'setup')}
 }
 let w=0,l=0;
 for(const s of sig){s.res='open';for(let j=s.i+1;j<Math.min(n,s.i+80);j++){
  const hitSL=s.dir>0?d[j].low<=s.sl:d[j].high>=s.sl,hitTP=s.dir>0?d[j].high>=s.tp:d[j].low<=s.tp;
  if(hitSL){s.res='loss';l++;break}if(hitTP){s.res='win';w++;break}}}
 const zones=[];
 for(const dir of [1,-1]){for(const e of ev.filter(e=>e.dir===dir).slice(-5).reverse()){
  let k=Math.max(0,e.to-30);for(let j=k;j<=e.to;j++){if(dir>0?d[j].low<d[k].low:d[j].high>d[k].high)k=j}
  const c=d[k],top=dir>0?Math.max(c.open,c.close):c.high,bot=dir>0?c.low:Math.min(c.open,c.close);
  let hit=false;for(let j=e.to+1;j<n;j++){if(dir>0?d[j].low<=top:d[j].high>=bot){hit=true;break}}
  if(!hit&&(dir>0?d[n-1].close>top:d[n-1].close<bot)){zones.push({dir,top,bot,i:k});break}}}
 let h=-1e9,lo=1e9;for(let j=Math.max(0,n-WIN);j<n;j++){h=Math.max(h,d[j].high);lo=Math.min(lo,d[j].low)}
 return{ev,sig,zones,hi:h,lo,trend,st:{w,l}}}

async function notify(title,msg){
 console.log(new Date().toISOString(),title,msg);
 if(!TOPIC)return;
 try{await fetch('https://ntfy.sh/'+encodeURIComponent(TOPIC),{method:'POST',body:msg,headers:{Title:title,Priority:'high',Tags:'bell'}})}
 catch(e){console.error('ntfy failed',e.message)}}
const marketClosed=()=>{if(/^BTC|^ETH/.test(SYMBOL))return false;const d=new Date(),w=d.getUTCDay(),h=d.getUTCHours();return w===6||(w===0&&h<22)||(w===5&&h>=22)};
async function bars(){
 const u=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}&interval=${TF}&outputsize=800&order=ASC&timezone=UTC&apikey=${KEY}`;
 const j=await (await fetch(u)).json();if(j.status==='error'||!j.values)throw new Error(j.message||'no data');
 return j.values.map(v=>({time:Math.floor(Date.parse(v.datetime.replace(' ','T')+'Z')/1000),open:+v.open,high:+v.high,low:+v.low,close:+v.close}))}
async function check(){
 if(marketClosed()){console.log('market closed, skipping');return}
 const all=await bars(),closed=all.slice(0,-1),q=all[all.length-1],ind=calc(closed),n=closed.length;
 // new signal on the latest closed candle
 const g=ind.sig[ind.sig.length-1];
 if(g&&g.i>=n-2){const k='s'+g.dir+closed[g.i].time;if(!fired.has(k)){fired.add(k);
  await notify(`${SYMBOL} ${g.dir>0?'BUY':'SELL'} ${g.early?'setup':'point'}`,`Entry ${g.e.toFixed(2)}  SL ${g.sl.toFixed(2)}  TP ${g.tp.toFixed(2)}  (${TF}). Not a guarantee, use your stop loss.`)}}
 // price touching a zone
 for(const z of ind.zones){const k='z'+z.dir+closed[z.i].time;
  if(!fired.has(k)&&q.low<=z.top&&q.high>=z.bot){fired.add(k);
   await notify(`${SYMBOL} entered ${z.dir>0?'BUY':'SELL'} zone`,`Zone ${z.bot.toFixed(2)} - ${z.top.toFixed(2)}, price ${q.close.toFixed(2)} (${TF}). Wait for confirmation.`)}}
 save();console.log(new Date().toISOString(),'checked',q.close.toFixed(2),'signals',ind.sig.length,'zones',ind.zones.length)}
async function main(){
 if(process.env.PORT)require('http').createServer((q,r)=>{r.end('ok')}).listen(process.env.PORT); // lets web hosts like Render see the app is alive
 if(!KEY){console.error('Set TWELVE_KEY');process.exit(1)}
 if(!TOPIC)console.warn('NTFY_TOPIC not set: alerts will only print in this console');
 await notify('SMC alerts started',`Watching ${SYMBOL} ${TF}, every ${POLL/1000}s`);
 const run=async()=>{try{await check()}catch(e){console.error('check failed:',e.message)}};
 await run();setInterval(run,POLL)}
module.exports={calc};
if(require.main===module)main();
