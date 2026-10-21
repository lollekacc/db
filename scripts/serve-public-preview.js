const path = require('node:path');
const { createServer } = require('../server');
const server = createServer({ publicPreview: true, staticRoot: path.resolve(__dirname, '../../df/dist/public-preview') });
server.listen(4173, '127.0.0.1', () => console.log('Public preview package: http://127.0.0.1:4173'));
