const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const api = require('./api/corn-futures');

const root = __dirname;
const port = Number(process.env.PORT || 8787);

function serveFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/corn-futures') {
    req.query = Object.fromEntries(url.searchParams.entries());
    api(req, res);
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    serveFile(res, path.join(root, 'index.html'), 'text/html; charset=utf-8');
    return;
  }
  res.statusCode = 404;
  res.end('Not found');
}).listen(port, () => {
  console.log('Corn futures dashboard: http://localhost:' + port);
});