const https = require('https');

const PORT = 54779;
const CSRF_TOKEN = "f151dcd5-1544-4ebf-941c-564f8be1dc74"; // your main --csrf_token

const bodyData = JSON.stringify({
  metadata: {
    ideName: "antigravity",
    extensionName: "antigravity",
    ideVersion: "unknown",
    locale: "en"
  }
});

const options = {
  hostname: '127.0.0.1',
  port: PORT,
  path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-codeium-csrf-token': CSRF_TOKEN,
    'Content-Length': Buffer.byteLength(bodyData)
  },
  rejectUnauthorized: false // accept the local self-signed cert
};

const req = https.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Response body:');
    console.log(data);
  });
});

req.on('error', (err) => {
  console.error('Request error:', err.message);
});

req.write(bodyData);
req.end();