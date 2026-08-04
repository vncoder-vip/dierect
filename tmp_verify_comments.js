const http = require('http');
const { createServer } = require('./server');
const server = createServer();
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  http.get({ host: '127.0.0.1', port, path: '/api/comments' }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      console.log(JSON.stringify({ status: res.statusCode, body }, null, 2));
      server.close();
    });
  }).on('error', (err) => {
    console.error(err);
    server.close();
    process.exit(1);
  });
});
