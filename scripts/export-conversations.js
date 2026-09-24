const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { createFieldCrypto } = require('../platform/field-crypto');

function renderArchive(conversations, connected) {
  const payload = JSON.stringify(conversations).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dealett — Conversations</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#182331;font:16px system-ui,sans-serif}header,main{max-width:1000px;margin:auto;padding:28px}header{padding-bottom:12px}h1{font-size:32px;margin:8px 0}p{line-height:1.6}.muted{color:#607080}.notice{padding:18px;background:#fff4d8;border-radius:12px}input{width:100%;padding:15px;border:1px solid #bac5d0;border-radius:10px;font:inherit}details{margin:14px 0;background:white;border:1px solid #dce2e8;border-radius:12px;overflow:hidden}summary{padding:20px;cursor:pointer;overflow-wrap:anywhere}summary strong{display:block;margin:7px 0}.transcript{padding:0 20px 20px}.message{padding:16px;margin:12px 0;background:#f1f4f7;border-radius:10px}.message.user{background:#e5f3ed}.meta{font-size:13px;color:#536575}.content{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;margin:10px 0 0}.tools{display:flex;gap:10px;margin:14px 0}button{padding:10px 16px;border:1px solid #bac5d0;background:white;border-radius:8px;cursor:pointer;font:inherit}#empty{padding:30px 0}@media(max-width:600px){header,main{padding:18px}h1{font-size:27px}}@media print{input,.tools{display:none}body{background:white}.message{break-inside:avoid}}
</style></head><body><header><div class="muted">DEALETT · CONVERSATION ARCHIVE</div><h1>All conversations</h1>
<p class="muted">${connected ? `Exported ${new Date().toISOString()} · Offline snapshot. Run the export again to include new messages.` : 'Waiting for a database connection'}</p>
${connected ? '' : '<p class="notice">No conversations have been loaded. This does not mean there are no conversations on the website. Connect the backend to its database, then run <strong>npm run export:conversations</strong> to populate this file.</p>'}
</header><main><label for="search">Search messages or conversation IDs</label><p><input id="search" type="search" placeholder="Search conversations…"></p><div class="tools"><button id="expand">Expand all</button><button id="collapse">Collapse all</button></div><p id="count" class="muted" aria-live="polite"></p><section id="list"></section><p id="empty" hidden>No matching conversations.</p></main>
<script type="application/json" id="data">${payload}</script><script>
const conversations=JSON.parse(document.getElementById('data').textContent);
const list=document.getElementById('list');
const date=value=>value?new Date(value).toLocaleString():'Unknown date';
function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
const entries=conversations.map(c=>{
 const details=element('details');const summary=element('summary');
 summary.append(element('span',date(c.created_at)+' · '+c.status+' · '+c.messages.length+' messages','meta'));
 summary.append(element('strong',c.messages.find(m=>m.role==='user')?.content?.slice(0,150)||'Conversation'));
 summary.append(element('span',c.id+(c.source_page?' · '+c.source_page:''),'meta'));details.append(summary);
 const transcript=element('div',undefined,'transcript');
 for(const m of c.messages){const box=element('article',undefined,'message '+m.role);box.append(element('div',(m.role==='user'?'Customer':m.role==='assistant'?'Dealett AI':m.role)+' · '+date(m.created_at)+' · #'+m.sequence,'meta'));box.append(element('div',m.content,'content'));if(m.structured_content&&Object.keys(m.structured_content).length){const extra=element('details');extra.append(element('summary','Offer and message details'));extra.append(element('pre',JSON.stringify(m.structured_content,null,2),'content'));box.append(extra);}transcript.append(box);}
 if(!c.messages.length)transcript.append(element('p','No saved messages.'));details.append(transcript);list.append(details);
 return {node:details,search:JSON.stringify(c).toLowerCase()};
});
function filter(){const query=document.getElementById('search').value.toLowerCase().trim();let count=0;for(const entry of entries){entry.node.hidden=!entry.search.includes(query);if(!entry.node.hidden)count++;}document.getElementById('count').textContent=count+' of '+entries.length+' conversations';document.getElementById('empty').hidden=count!==0;}
document.getElementById('search').addEventListener('input',filter);
document.getElementById('expand').onclick=()=>entries.filter(e=>!e.node.hidden).forEach(e=>e.node.open=true);
document.getElementById('collapse').onclick=()=>entries.forEach(e=>e.node.open=false);filter();
</script></body></html>`;
}

async function main() {
  const envFile = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const output = path.resolve(__dirname, '../../reports/conversations.html');
  let conversations = [];
  const connected = Boolean(process.env.DATABASE_URL);
  if (!connected && !process.argv.includes('--empty')) throw new Error('DATABASE_URL is not configured. Existing export was left unchanged.');
  if (!connected && fs.existsSync(output)) throw new Error('Refusing to replace an existing archive with an empty viewer.');
  if (connected) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 10000 });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SELECT set_config('app.actor_type', 'system', true)");
      conversations = (await client.query('SELECT id, status, language, source_page, created_at, updated_at FROM conversations ORDER BY created_at DESC, id')).rows;
      const messages = (await client.query('SELECT conversation_id, sequence, role, content_text, content_encrypted, structured_content, created_at FROM conversation_messages ORDER BY conversation_id, sequence')).rows;
      const crypto = messages.some(m => m.content_encrypted) ? createFieldCrypto(process.env.DEALETT_DATA_ENCRYPTION_KEY) : null;
      const byId = new Map(conversations.map(c => { c.messages = []; return [c.id, c]; }));
      for (const message of messages) {
        const { content_text, content_encrypted, conversation_id, ...metadata } = message;
        byId.get(conversation_id)?.messages.push({ ...metadata, content: content_encrypted ? crypto.decrypt(content_encrypted) : content_text });
      }
      await client.query('COMMIT');
    } finally {
      if (client) client.release();
      await pool.end();
    }
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = output + '.tmp';
  fs.writeFileSync(temporary, renderArchive(conversations, connected), { mode: 0o600 });
  fs.renameSync(temporary, output);
  console.log(connected ? `Exported ${conversations.length} conversations to ${output}` : `Created unpopulated viewer at ${output}`);
}

if (require.main === module) main().catch(() => {
  console.error('Conversation export failed. Check DATABASE_URL, database access and DEALETT_DATA_ENCRYPTION_KEY. Existing export was left unchanged.');
  process.exitCode = 1;
});
module.exports = { renderArchive };
