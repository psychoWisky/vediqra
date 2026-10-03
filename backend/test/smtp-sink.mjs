// TEST ONLY: a tiny SMTP server that records mail instead of sending it, so email code can be tested with no
// SMTP account.   SMTP on :2525, control API on :2526
//   GET  /messages          -> [{to:[...], data:"..."}]
//   POST /reset             -> clear recorded mail
//   POST /mode?fail=1|0     -> 1: refuse every recipient (550), 0: accept
import net from 'node:net';
import http from 'node:http';

let messages = [];
let fail = false;

net.createServer((sock) => {
  let buf = '', inData = false, current = { to: [], data: '' };
  const send = (l) => sock.write(l + '\r\n');
  send('220 sink ESMTP');
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end === -1) return;
        current.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        messages.push(current);
        current = { to: [], data: '' };
        inData = false;
        send('250 queued');
        continue;
      }
      const nl = buf.indexOf('\r\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') { send('250-sink'); send('250 8BITMIME'); }
      else if (cmd === 'HELO') send('250 sink');
      else if (cmd === 'MAIL') send('250 ok');
      else if (cmd === 'RCPT') {
        if (fail) send('550 mailbox refused');
        else { current.to.push((line.match(/<([^>]*)>/) || [])[1]); send('250 ok'); }
      }
      else if (cmd === 'DATA') { if (current.to.length === 0) send('554 no valid recipients'); else { inData = true; send('354 go'); } }
      else if (cmd === 'RSET' || cmd === 'NOOP') send('250 ok');
      else if (cmd === 'QUIT') { send('221 bye'); sock.end(); }
      else send('250 ok');
    }
  });
  sock.on('error', () => {});
}).listen(2525, '127.0.0.1');

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/messages') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(messages)); }
  if (url.pathname === '/reset') { messages = []; return res.end('ok'); }
  if (url.pathname === '/mode') { fail = url.searchParams.get('fail') === '1'; return res.end('ok'); }
  res.statusCode = 404; res.end();
}).listen(2526, '127.0.0.1');
console.log('smtp sink on 2525, control on 2526');
