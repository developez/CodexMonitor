const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
process.env.TZ = 'Europe/Madrid';

// Run the real inline application, replacing only browser/HTTP boundaries.
function app(storage = new Map()) {
  const html = readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, innerHTML: '', parentElement: {clientWidth:1200}, addEventListener() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    console, TextDecoderStream, Response, setTimeout, clearTimeout,
    document: { getElementById: element, querySelectorAll: () => [], documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: () => '#888' }),
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v),
      removeItem: k => storage.delete(k), key: i => [...storage.keys()][i], get length() { return storage.size; } },
    window: { matchMedia: () => ({ addEventListener() {} }), addEventListener() {} },
    location: {hash:'',pathname:'/'}, history: {replaceState() {}},
    Chart: class { constructor(canvas, config) { this.config = config; } destroy() {} },
    fetch: async () => { throw new Error('Unexpected HTTP request'); },
  });
  vm.runInContext(source.replace(/\ninit\(\)\.catch\([^\n]*\);?\s*$/, ''), context);
  // Existing tests exercise the entire history; date-specific tests set their bounds.
  element('dateFrom').value = '';
  element('dateTo').value = '';
  const run = code => vm.runInContext(code, context);
  const json = code => JSON.parse(JSON.stringify(run(code)));
  return { context, run, json, element, storage };
}

test('Codex hourly summaries deduplicate own responses and exclude inherited fork usage',async()=>{
  const a=app();
  const meta={type:'session_meta',payload:{id:'root',cwd:'C:/p',thread_source:'user'}};
  const record=(id,thread,ts,n)=>({type:'token_usage_record',timestamp:ts,payload:{response_id:id,thread_id:thread,
    usage:{input_tokens:n,cached_input_tokens:20,cache_write_input_tokens:10,output_tokens:30,reasoning_output_tokens:10}}});
  const lines=[meta,{type:'turn_context',payload:{model:'gpt-6.2-sol'}},
    record('a','root','2026-11-20T01:59:59Z',99),record('a','root','2026-11-20T01:59:59Z',120),
    record('b','root','2026-11-20T02:00:00Z',220),record('parent','foreign','2026-11-20T03:00:00Z',9999)];
  a.context.fetch=async()=>new Response(lines.map(o=>JSON.stringify(o)).join('\n'));
  a.context.result=await a.run("parseTranscript('fixture')");
  assert.equal(a.run('result.requests'),2);
  assert.equal(a.run('result.total'),400);
  assert.equal(a.run("result.days['2026-11-20']['gpt-6.2-sol'].input_tokens"),280);
  assert.equal(a.run("result.hours?.['2026-11-20T02']?.['gpt-6.2-sol'].input_tokens"),90);
  assert.equal(a.run("result.hours?.['2026-11-20T03']?.['gpt-6.2-sol'].reasoning_tokens"),10);
  assert.equal(a.run('result.tokens.cache_read_input_tokens'),40);
});

test('hour blocks use local midnight boundaries and conserve tokens at all granularities', () => {
  const a = app();
  a.run("globalThis.fixture = Object.fromEntries([['00',1],['02',2],['03',4],['07',8],['08',16],['11',32],['12',64],['23',128]].map(([h,n]) => ['2026-11-20T'+h, {m:{input_tokens:n}}]))");
  assert.equal(a.run('typeof groupHours'), 'function');
  assert.deepEqual(a.json('Object.keys(groupHours(fixture, 3))'), ['2026-11-20T00','2026-11-20T03','2026-11-20T06','2026-11-20T09','2026-11-20T12','2026-11-20T21']);
  assert.deepEqual(a.json('Object.values(groupHours(fixture, 8)).map(m => m.m.input_tokens)'), [15,112,128]);
  assert.deepEqual(a.json('Object.values(groupHours(fixture, 12)).map(m => m.m.input_tokens)'), [63,192]);
  for (const span of [1,3,8,12]) assert.equal(a.run(`Object.values(groupHours(fixture, ${span})).reduce((n,m) => n+m.m.input_tokens,0)`), 255);
});

test('range fills gaps across midnight and daylight saving without shifting block boundaries', () => {
  const a = app();
  assert.equal(a.run('typeof timeRange'), 'function');
  assert.deepEqual(a.json("timeRange(['2026-11-20T21','2026-11-21T03'],3)"), ['2026-11-20T21','2026-11-21T00','2026-11-21T03']);
  assert.deepEqual(a.json("timeRange(['2026-03-29T00','2026-03-29T12'],3)"), ['2026-03-29T00','2026-03-29T03','2026-03-29T06','2026-03-29T09','2026-03-29T12']);
  assert.deepEqual(a.json("timeRange(['2026-10-24','2026-10-26'],24)"), ['2026-10-24','2026-10-25','2026-10-26']);
});

test('old transcript cache is rebuilt once, then new hourly cache is reused', async () => {
  const a = app();
  a.storage.set('cx1:fixture', JSON.stringify({ mtime: 'same', size: '100', data: { old: true } }));
  let reads = 0;
  a.context.fetch = async (url, opts) => {
    if (opts?.method === 'HEAD') return new Response('', { headers: { 'Last-Modified': 'same', 'Content-Length': '100' } });
    reads++;
    return new Response('');
  };
  const first = await a.run("summary('fixture',{mtime:'same',size:'100'})");
  const second = await a.run("summary('fixture',{mtime:'same',size:'100'})");
  assert.equal(first.old, undefined);
  assert.equal(reads, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(second.hours)), {});
});

test('chart uses selected blocks, zero gaps, project/cache filters and unchanged costs', () => {
  const a = app();
  a.element('granularity').value = '3';
  a.element('project').value = 'p';
  a.run(`tab='days'; sessions=[{project:'p',done:true,
    days:{'2026-11-20':{'gpt-6.2-sol':{input_tokens:300,cache_read_input_tokens:100}}},
    hours:{'2026-11-20T00':{'gpt-6.2-sol':{input_tokens:100,cache_read_input_tokens:100}},'2026-11-20T06':{'gpt-6.2-sol':{input_tokens:200}}}},
    {project:'other',done:true,hours:{'2026-11-20T00':{m:{input_tokens:999}}}}]; renderDays()`);
  assert.deepEqual(a.json('dayChart.config.data.datasets[0].data'), [100,0,200]);
  assert.match(a.element('daysMeta').innerHTML, /Tramos con actividad/);
  assert.match(a.run('dayChart.config.options.plugins.tooltip.callbacks.title([{dataIndex:0}])'), /00:00.*03:00/);
  a.element('hideCacheRead').checked = true;
  a.element('metric').value = 'cost';
  a.run('renderDays()');
  const total = a.run('dayChart.config.data.datasets.reduce((n,d)=>n+d.data.reduce((a,b)=>a+b,0),0)');
  assert.ok(Math.abs(total - 0.0006 / 1.0992) < 1e-12);
  a.element('granularity').value = '24';
  a.run('renderDays()');
  assert.ok(Math.abs(a.run('dayChart.config.data.datasets.reduce((n,d)=>n+d.data[0],0)')-total) < 1e-12);
  a.element('groupBy').value = 'model';
  for (const span of [1,3,8,12]) {
    a.element('granularity').value = String(span);
    a.run('renderDays()');
    assert.equal(a.run('dayChart.config.data.datasets.length'),1);
    assert.equal(a.run('dayChart.config.data.datasets[0].label'),'gpt-6.2-sol');
    assert.ok(Math.abs(a.run('dayChart.config.data.datasets[0].data.reduce((a,b)=>a+b,0)')-total) < 1e-12);
  }
});

test('Codex combines main, subagent and automatic review hours under their root session',async()=>{
  const a=app();
  const files=[];
  for(const [id,kind,n,ts] of [['root','user',100,'2026-11-20T07:00:00Z'],['agent','subagent',50,'2026-11-20T07:30:00Z'],['review','guardian_review',25,'2026-11-20T19:00:00Z']]){
    const lines=[{type:'session_meta',payload:{id,session_id:'root',parent_thread_id:id==='root'?null:'root',thread_source:kind,cwd:'C:/p'}},
      {type:'turn_context',payload:{model:'gpt-6.2-sol'}},
      {type:'token_usage_record',timestamp:ts,payload:{thread_id:id,response_id:id,usage:{input_tokens:n}}}];
    a.context.fetch=async()=>new Response(lines.map(o=>JSON.stringify(o)).join('\n'));
    files.push({path:id,mtime:'2026-11-20',data:await a.run("parseTranscript('fixture')")});
  }
  a.context.files=files;
  a.run('sessions=buildSessions(files)');
  assert.equal(a.run('sessions.length'),1);
  assert.equal(a.run('sessions[0].total'),175);
  assert.equal(a.run('sessions[0].agents.length'),2);
  assert.equal(a.run('sessions[0].agents.filter(a=>a.review).length'),1);
  assert.equal(a.run("sessions[0].hours?.['2026-11-20T08']?.['gpt-6.2-sol'].input_tokens"),150);
  assert.equal(a.run("sessions[0].hours?.['2026-11-20T20']?.['gpt-6.2-sol'].input_tokens"),25);
});

test('empty hourly blocks keep a zero tooltip and callbacks tolerate no items', () => {
  const a = app();
  a.element('granularity').value = '1';
  a.run(`tab='days'; sessions=[{done:true,hours:{
    '2026-11-20T00':{m:{input_tokens:100}}, '2026-11-20T02':{m:{input_tokens:200}}
  }}]; renderDays()`);
  assert.equal(a.run('dayChart.config.options.plugins.tooltip.filter({raw:0,dataIndex:1})'),true);
  assert.match(a.run('dayChart.config.options.plugins.tooltip.callbacks.title([{dataIndex:1}])'),/01:00.*02:00/);
  assert.equal(a.run('dayChart.config.options.plugins.tooltip.callbacks.title([])'),'');
  assert.deepEqual(a.json('dayChart.config.options.plugins.tooltip.callbacks.footer([])'),[]);
});

test('changing browser time zone regenerates cached local-hour summaries', async () => {
  const madrid = app();
  madrid.run("cacheSet('fixture',{mtime:'same',size:'100',data:{oldZone:true}})");
  process.env.TZ = 'UTC';
  try {
    const utc = app(madrid.storage);
    let reads = 0;
    utc.context.fetch = async (url, opts) => {
      if (opts?.method==='HEAD') return new Response('',{headers:{'Last-Modified':'same','Content-Length':'100'}});
      reads++;
      return new Response([
        {type:'session_meta',payload:{id:'root'}},
        {type:'turn_context',payload:{model:'m'}},
        {type:'token_usage_record',timestamp:'2026-11-20T07:00:00Z',payload:{thread_id:'root',response_id:'a',usage:{input_tokens:100}}}
      ].map(o=>JSON.stringify(o)).join('\n'));
    };
    const result = await utc.run("summary('fixture',{mtime:'same',size:'100'})");
    assert.equal(result.oldZone,undefined);
    assert.equal(reads,1);
    assert.equal(result.hours['2026-11-20T07'].m.input_tokens,100);
  } finally {
    process.env.TZ = 'Europe/Madrid';
  }
});

test('Codex cache cleanup removes obsolete summaries and preserves other monitor data',()=>{
  const a=app();
  a.storage.set('cx1:old','old');
  a.storage.set('cm4:Europe/Madrid:claude','keep');
  a.storage.set('unrelated-preference','keep');
  a.run("cacheSet('current',{hours:{}}); clearLegacyCache()");
  assert.equal(a.storage.has('cx1:old'),false);
  assert.equal(a.storage.get('cm4:Europe/Madrid:claude'),'keep');
  assert.equal(a.storage.get('unrelated-preference'),'keep');
  assert.deepEqual(a.json("cacheGet('current')"),{hours:{}});
});

test('date defaults cover today and two previous local calendar days', () => {
  const a = app();
  assert.equal(a.run('typeof setDefaultDateRange'),'function');
  for (const [now, from, to] of [
    ['2026-11-21T12:00:00','2026-11-19','2026-11-21'],
    ['2026-03-01T00:30:00','2026-02-27','2026-03-01'],
    ['2026-03-30T00:30:00','2026-03-28','2026-03-30'],
  ]) {
    a.run(`setDefaultDateRange(new Date('${now}'))`);
    assert.equal(a.element('dateFrom').value,from);
    assert.equal(a.element('dateTo').value,to);
  }
});

test('date filter includes both boundary days for every granularity and scopes totals and sessions', () => {
  const a = app();
  a.element('dateFrom').value='2026-11-20';
  a.element('dateTo').value='2026-11-21';
  a.run(`tab='days'; sessions=[{done:true,
    days:{'2026-11-19':{'gpt-6.2-sol':{input_tokens:999}},'2026-11-20':{'gpt-6.2-sol':{input_tokens:100}},'2026-11-21':{'gpt-6.2-sol':{input_tokens:200}},'2026-11-22':{'gpt-6.2-sol':{input_tokens:999}}},
    hours:{'2026-11-19T23':{'gpt-6.2-sol':{input_tokens:999}},'2026-11-20T00':{'gpt-6.2-sol':{input_tokens:100}},'2026-11-21T23':{'gpt-6.2-sol':{input_tokens:200}},'2026-11-22T00':{'gpt-6.2-sol':{input_tokens:999}}}},
    {done:true,days:{'2026-11-18':{m:{input_tokens:999}}},hours:{'2026-11-18T00':{m:{input_tokens:999}}}}]`);
  for (const span of [24,1,3,8,12]) {
    a.element('granularity').value=String(span);
    a.element('metric').value='tokens';
    a.run('renderDays()');
    assert.equal(a.run('dayChart.config.data.datasets[0].data.reduce((a,b)=>a+b,0)'),300);
    assert.equal(a.run('dayChart.config.data.labels.length'),48/span);
    assert.match(a.element('daysMeta').innerHTML,/Sesiones: <b>1<\/b>/);
    a.element('metric').value='cost';
    a.run('renderDays()');
    assert.ok(Math.abs(a.run('dayChart.config.data.datasets[0].data.reduce((a,b)=>a+b,0)')-0.0006/1.0992)<1e-12);
  }
  a.element('dateFrom').value='2026-11-19';
  a.element('dateTo').value='2026-11-21';
  a.element('granularity').value='24';
  a.run('renderDays()');
  assert.equal(a.run('dayChart.config.data.labels.length'),3);
});

test('empty or reversed date ranges clear the previous chart, and bounds may be open', () => {
  const a=app();
  a.run("tab='days'; sessions=[{done:true,days:{'2026-11-20':{m:{input_tokens:100}}}}]; renderDays()");
  a.element('dateFrom').value='2026-11-21';
  a.element('dateTo').value='2026-11-22';
  a.run('renderDays()');
  assert.equal(a.run('dayChart'),null);
  assert.match(a.element('daysMeta').innerHTML,/Sin datos/);
  a.element('dateTo').value='2026-11-19';
  a.run('renderDays()');
  assert.match(a.element('daysMeta').innerHTML,/Desde.*Hasta/);
  a.element('dateFrom').value='';
  a.element('dateTo').value='2026-11-20';
  a.run('renderDays()');
  assert.equal(a.run('dayChart.config.data.datasets[0].data[0]'),100);
});

test('selected calendar dates keep quiet leading and trailing days as zero', () => {
  const a=app();
  a.element('dateFrom').value='2026-11-19';
  a.element('dateTo').value='2026-11-21';
  a.run(`tab='days'; sessions=[{done:true,days:{'2026-11-20':{m:{input_tokens:100}}},
    hours:{'2026-11-20T08':{m:{input_tokens:100}}}}]; renderDays()`);
  assert.deepEqual(a.json('dayChart.config.data.datasets[0].data'),[0,100,0]);
  assert.match(a.element('daysMeta').innerHTML,/Días con actividad: <b>1<\/b>/);
  a.element('granularity').value='1';
  a.run('renderDays()');
  assert.equal(a.run('dayChart.config.data.labels.length'),72);
  assert.equal(a.run('dayChart.config.data.datasets[0].data[32]'),100);
  assert.equal(a.run('dayChart.config.data.datasets[0].data.reduce((a,b)=>a+b,0)'),100);
});

test('very large hourly date ranges ask for a narrower interval before building a chart', () => {
  const a=app();
  a.element('dateFrom').value='2020-01-01';
  a.element('dateTo').value='2026-11-21';
  a.element('granularity').value='1';
  a.run("tab='days'; sessions=[{done:true,hours:{'2026-11-20T08':{m:{input_tokens:100}}}}]; renderDays()");
  assert.equal(a.run('dayChart === null'),true);
  assert.match(a.element('daysMeta').innerHTML,/Reduce.*fechas.*granularidad/);
  a.element('granularity').value='24';
  a.run("sessions[0].days={'2026-11-20':{m:{input_tokens:100}}}; renderDays()");
  assert.equal(a.run('dayChart !== null'),true);
});

test('day/night boundaries split mixed hour blocks at 08:00 and 20:00', () => {
  const a=app();
  assert.equal(a.run('typeof dayNightSegments'),'function');
  assert.deepEqual(a.json("dayNightSegments(['2026-11-20T06'],3)"),[
    {start:0,end:2/3,day:false},{start:2/3,end:1,day:true},
  ]);
  assert.deepEqual(a.json("dayNightSegments(['2026-11-20T16'],8)"),[
    {start:0,end:0.5,day:true},{start:0.5,end:1,day:false},
  ]);
  assert.deepEqual(a.json("dayNightSegments(['2026-11-20T00','2026-11-20T12'],12)"),[
    {start:0,end:2/3,day:false},{start:2/3,end:1+2/3,day:true},{start:1+2/3,end:2,day:false},
  ]);
  assert.deepEqual(a.json("dayNightSegments(['2026-11-20T21','2026-11-21T00','2026-11-21T03'],3)"),[
    {start:0,end:3,day:false},
  ]);
});

test('day/night switch paints chart background behind unchanged usage and turns off in daily mode', () => {
  const a=app();
  a.element('granularity').value='8';
  a.run(`tab='days'; sessions=[{done:true,
    hours:{'2026-11-20T00':{m:{input_tokens:100}},'2026-11-20T16':{m:{input_tokens:200}}},
    days:{'2026-11-20':{m:{input_tokens:300}}}}]; renderDays()`);
  const before=a.json('dayChart.config.data');
  a.element('showDayNight').checked=true;
  a.run('renderDays()');
  assert.deepEqual(a.json('dayChart.config.data'),before);
  assert.equal(a.element('dayNightLegend').hidden,false);
  assert.equal(a.run("dayChart.config.plugins.some(p=>p.id==='dayNightBands')"),true);
  a.run(`globalThis.rects=[]; globalThis.symbols=[];
    globalThis.fakeCanvas={chartArea:{left:10,right:310,top:20,bottom:220},ctx:{
      save(){},restore(){},beginPath(){},rect(){},clip(){},
      fillRect(x,y,w,h){rects.push([x,y,w,h,this.fillStyle])},
      fillText(s){symbols.push(s)}
    }};
    dayChart.config.plugins.find(p=>p.id==='dayNightBands').beforeDraw(fakeCanvas)`);
  assert.deepEqual(a.json('rects.map(r=>r.slice(0,4))'),[
    [10,20,100,200],[110,20,150,200],[260,20,50,200],
  ]);
  assert.ok(a.json('symbols').some(s=>s.includes('☀')));
  assert.ok(a.json('symbols').some(s=>s.includes('☾') && s.includes('✦')));
  a.element('showDayNight').checked=false;
  a.run('renderDays()');
  assert.equal(a.element('dayNightLegend').hidden,true);
  a.run("rects=[]; dayChart.config.plugins.find(p=>p.id==='dayNightBands')?.beforeDraw(fakeCanvas)");
  assert.deepEqual(a.json('rects'),[]);
  a.element('showDayNight').checked=true;
  a.element('granularity').value='24';
  a.run('renderDays()');
  assert.equal(a.element('showDayNight').disabled,true);
  assert.equal(a.element('dayNightLegend').hidden,true);
  a.run("rects=[]; dayChart.config.plugins.find(p=>p.id==='dayNightBands')?.beforeDraw(fakeCanvas)");
  assert.deepEqual(a.json('rects'),[]);
});


test('hourly views retain the remote label layout for ranges longer than 31 blocks',()=>{
  const a=app();
  a.element('dateFrom').value='2026-11-19';
  a.element('dateTo').value='2026-11-21';
  a.element('granularity').value='1';
  a.run("tab='days'; sessions=[{done:true,hours:{'2026-11-20T08':{m:{input_tokens:100}}}}]; renderDays()");
  a.run("globalThis.captions=[]; globalThis.labelChart={data:dayChart.config.data,scales:{x:{width:1200}},ctx:{save(){},restore(){},translate(){},rotate(){},measureText(s){return {width:s.length*6}},fillText(s){captions.push(s)}},getDatasetMeta(){return {hidden:false,data:Array.from({length:72},(_,i)=>({x:i*16,y:100}))}}};dayChart.config.plugins.find(p=>p.id==='dayTotals').afterDatasetsDraw(labelChart)");
  assert.equal(a.run('captions.length'),2);
  assert.equal(a.run('captions[0]'),'100');
});
